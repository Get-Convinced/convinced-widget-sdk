import type { ConvincedClient } from './client.js'
import type {
  IdentityInput,
  IdentityResponse,
  JsonObject,
  JsonValue,
  WidgetDemoRequestLifecycleEvent,
} from './types.js'

const DEFAULT_EVENT_PREFIX = 'widget.'
const MAX_REPLAY_URL_LENGTH = 2_048

/**
 * The small PostHog browser surface used by the SDK bridge. Keeping this as a
 * structural interface makes PostHog an optional peer chosen by the host page.
 */
export interface PostHogBrowserClient {
  capture(
    eventName: string,
    properties?: Record<string, unknown>,
    options?: { transport?: 'XHR' | 'fetch' | 'sendBeacon'; send_instantly?: boolean },
  ): unknown
  identify(distinctId: string, properties?: Record<string, unknown>): unknown
  register_for_session?(properties: Record<string, unknown>): unknown
  startSessionRecording?(override?: boolean | Record<string, boolean>): unknown
  stopSessionRecording?(): unknown
  get_session_id?(): string | undefined
  get_session_replay_url?(options?: {
    withTimestamp?: boolean
    timestampLookBack?: number
  }): string | undefined
}

// Widget lifecycle events are low-volume and often emitted immediately before
// a voice/session teardown. Bypass the browser SDK's request batch so a short-
// lived host page cannot report an event locally and close before transport.
const IMMEDIATE_CAPTURE = Object.freeze({ send_instantly: true } as const)

export interface PostHogSessionLink {
  convincedSessionId: string
  posthogSessionId: string | null
  replayUrl: string | null
}

export interface ConvincedPostHogBridgeOptions {
  client: ConvincedClient
  posthog: PostHogBrowserClient
  /** Defaults to `widget.` so the bridge follows the hosted widget taxonomy. */
  eventPrefix?: `${string}.`
  /**
   * Optional, explicit PostHog person-property policy. The safe default sends
   * no email, name, phone, or company; PostHog receives only the opaque
   * Convinced visitor id as its distinct id.
   */
  identityProperties?: (
    input: Readonly<IdentityInput>,
    response: Readonly<IdentityResponse>,
  ) => Record<string, unknown>
  /** Persist replay correlation into the signed Convinced session context. */
  persistCorrelation?: boolean
}

/**
 * Correlates optional PostHog analytics with the authoritative Convinced
 * session. PostHog remains observational: identity and lifecycle writes still
 * go through Convinced's session-scoped capability.
 */
export class ConvincedPostHogBridge {
  private readonly client: ConvincedClient
  private readonly posthog: PostHogBrowserClient
  private readonly eventPrefix: `${string}.`
  private readonly identityProperties?: ConvincedPostHogBridgeOptions['identityProperties']
  private readonly persistCorrelation: boolean
  private removeIdentityListener: (() => void) | null = null
  private removeDemoRequestListener: (() => void) | null = null
  private currentLink: PostHogSessionLink | null = null

  constructor(options: ConvincedPostHogBridgeOptions) {
    this.client = options.client
    this.posthog = options.posthog
    this.eventPrefix = options.eventPrefix ?? DEFAULT_EVENT_PREFIX
    this.identityProperties = options.identityProperties
    this.persistCorrelation = options.persistCorrelation !== false
  }

  get link(): PostHogSessionLink | null {
    return this.currentLink ? { ...this.currentLink } : null
  }

  async start(): Promise<PostHogSessionLink> {
    if (!this.client.state.session) await this.client.initialize()
    const convincedSessionId = this.client.state.session?.sessionId
    if (!convincedSessionId) throw new Error('A Convinced session is required before PostHog is linked.')

    const sessionProperties = {
      convinced_session_id: convincedSessionId,
      convinced_org_slug: this.client.orgSlug,
    }
    this.posthog.register_for_session?.(sessionProperties)
    this.posthog.startSessionRecording?.({ linked_flag: true, sampling: true })

    const posthogSessionId = safePostHogSessionId(this.posthog.get_session_id?.())
    this.posthog.capture(`${this.eventPrefix}session_linked`, {
      orgSlug: this.client.orgSlug,
      sessionId: convincedSessionId,
      posthogSessionId,
    }, IMMEDIATE_CAPTURE)
    const replayUrl = safeReplayUrl(this.posthog.get_session_replay_url?.())
    this.currentLink = { convincedSessionId, posthogSessionId, replayUrl }

    if (this.persistCorrelation) {
      await this.persistLink(this.currentLink)
    }
    if (!this.removeIdentityListener) {
      this.removeIdentityListener = this.client.on('identity', ({ input, response }) => {
        void this.identify(input, response).catch(() => undefined)
      })
    }
    if (!this.removeDemoRequestListener) {
      this.removeDemoRequestListener = this.client.on('demo_request', (event) => {
        this.captureDemoRequestLifecycle(event)
      })
    }
    return { ...this.currentLink }
  }

  /** Refreshes the replay URL after PostHog has emitted its first snapshot. */
  async refreshLink(): Promise<PostHogSessionLink> {
    if (!this.currentLink) return this.start()
    const next: PostHogSessionLink = {
      ...this.currentLink,
      posthogSessionId:
        safePostHogSessionId(this.posthog.get_session_id?.()) ??
        this.currentLink.posthogSessionId,
      replayUrl:
        safeReplayUrl(this.posthog.get_session_replay_url?.({
          withTimestamp: true,
          timestampLookBack: 30,
        })) ?? this.currentLink.replayUrl,
    }
    this.currentLink = next
    if (this.persistCorrelation) await this.persistLink(next)
    return { ...next }
  }

  /**
   * Call after Convinced accepts identity. The bridge identifies with the
   * opaque server-issued visitor id, never the email address.
   */
  async identify(input: IdentityInput, response: IdentityResponse): Promise<void> {
    const visitorId = safeVisitorId(response.visitorId)
    if (!visitorId) throw new Error('PostHog identity requires a valid Convinced visitor id.')
    const mapped = this.identityProperties?.(Object.freeze({ ...input }), Object.freeze({ ...response })) ?? {}
    this.posthog.identify(visitorId, compactUnknownRecord(mapped))
    this.posthog.capture(`${this.eventPrefix}identity_confirmed`, {
      orgSlug: this.client.orgSlug,
      sessionId: this.client.state.session?.sessionId,
      hasName: Boolean(input.name),
      hasCompany: Boolean(input.company || response.derivedCompany),
      hasPhone: Boolean(input.phone),
    }, IMMEDIATE_CAPTURE)
  }

  /**
   * Emit the same lifecycle signal to PostHog and, by default, the signed
   * Convinced behavior timeline. Use it for navigation, tools, and media.
   */
  async capture(
    name: string,
    properties: Record<string, unknown> = {},
    options: { authoritative?: boolean } = {},
  ): Promise<void> {
    const normalized = normalizeEventName(name)
    const safeProperties = compactUnknownRecord(properties)
    this.posthog.capture(`${this.eventPrefix}${normalized}`, {
      orgSlug: this.client.orgSlug,
      sessionId: this.client.state.session?.sessionId,
      ...safeProperties,
    }, IMMEDIATE_CAPTURE)
    if (options.authoritative !== false) {
      await this.client.track(normalized, toJsonObject(safeProperties))
    }
  }

  stop(): void {
    this.removeIdentityListener?.()
    this.removeIdentityListener = null
    this.removeDemoRequestListener?.()
    this.removeDemoRequestListener = null
    this.posthog.stopSessionRecording?.()
  }

  private captureDemoRequestLifecycle(event: WidgetDemoRequestLifecycleEvent): void {
    const properties = event.status === 'opened'
      ? { surface: event.surface }
      : event.status === 'submitted'
        ? {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            ...(event.submittedAt ? { submittedAt: event.submittedAt } : {}),
            alreadySubmitted: event.alreadySubmitted,
            identityLinked: event.identityLinked,
            hasCompany: event.hasCompany,
            hasPhone: event.hasPhone,
          }
        : {
            stage: event.stage,
            errorCode: event.errorCode,
            hasCompany: event.hasCompany,
            hasPhone: event.hasPhone,
          }
    const eventName = event.status === 'opened'
      ? 'demo_opened'
      : event.status === 'submitted'
        ? 'demo_submitted'
        : 'demo_failed'
    this.posthog.capture(`${this.eventPrefix}${eventName}`, {
      orgSlug: this.client.orgSlug,
      sessionId: this.client.state.session?.sessionId,
      ...properties,
    }, IMMEDIATE_CAPTURE)
  }

  private persistLink(link: PostHogSessionLink): Promise<void> {
    return this.client.track('analytics_session_linked', {
      provider: 'posthog',
      ...(link.posthogSessionId ? { analyticsSessionId: link.posthogSessionId } : {}),
      ...(link.replayUrl ? { replayUrl: link.replayUrl } : {}),
    })
  }
}

export function createPostHogBridge(
  options: ConvincedPostHogBridgeOptions,
): ConvincedPostHogBridge {
  return new ConvincedPostHogBridge(options)
}

function normalizeEventName(value: string): string {
  const trimmed = value.trim().replace(/^widget\./, '')
  if (!/^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(trimmed)) {
    throw new Error('PostHog bridge event names must be 1-128 safe characters.')
  }
  return trimmed
}

function safePostHogSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^[A-Za-z0-9_-]{1,128}$/.test(trimmed) ? trimmed : null
}

function safeVisitorId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^[A-Za-z0-9_-]{1,256}$/.test(trimmed) ? trimmed : null
}

function safeReplayUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_REPLAY_URL_LENGTH) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && /(^|\.)posthog\.com$/i.test(url.hostname)
      ? url.toString()
      : null
  } catch {
    return null
  }
}

function compactUnknownRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) =>
        /^[A-Za-z0-9_$.-]{1,128}$/.test(key) &&
        item !== undefined &&
        item !== null &&
        typeof item !== 'function' &&
        typeof item !== 'symbol')
      .slice(0, 64),
  )
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  const serialized = JSON.stringify(value)
  if (new TextEncoder().encode(serialized).byteLength > 16 * 1024) {
    throw new Error('PostHog bridge properties exceed 16 KiB.')
  }
  return JSON.parse(serialized) as Record<string, JsonValue>
}

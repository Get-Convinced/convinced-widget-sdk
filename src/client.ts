import { parseAssistantContent } from './content.js'
import { TypedEventEmitter } from './events.js'
import { ClientToolRegistry } from './tools/registry.js'
import {
  SSE_DONE,
  ConvincedApiError,
  apiError,
  iterateSse,
  normalizeApiBase,
  readJsonResponse,
} from './transport.js'
import {
  HOST_TOOL_PROTOCOL_VERSION,
  MAX_HOST_TOOL_CALLS_PER_TURN,
  MAX_HOST_TOOLS,
  type ChatHistoryMessage,
  type ChatMessage,
  type BrowserSessionInputOptions,
  type ClientTool,
  type ClientToolCall,
  type ClientToolDefinition,
  type ClientToolResult,
  type ConvincedClientEventListener,
  type ConvincedClientEventMap,
  type ConvincedClientEventName,
  type ConvincedClientState,
  type EndWidgetSessionOptions,
  type IdentityInput,
  type IdentityResponse,
  type InitializeOptions,
  type JsonObject,
  type JsonValue,
  type SendMessageOptions,
  type SlideItem,
  type SlideMetadata,
  type SseClientToolCallEvent,
  type SseClientToolPauseEvent,
  type WidgetConfig,
  type WidgetBehaviorEvent,
  type WidgetDemoRequestInput,
  type WidgetDemoRequestLifecycleEvent,
  type WidgetDemoRequestResponse,
  type WidgetSessionInput,
  type WidgetSessionAttribution,
  type WidgetSessionResponse,
  type WidgetVisitorIntelResponse,
  type WidgetVoiceCredentialResponse,
  type WidgetSseEvent,
  type UpdateSessionContextInput,
  type VisitorIdentity,
} from './types.js'

export const DEFAULT_API_BASE = 'https://app.getconvinced.ai'
const MAX_CLIENT_TOOL_ROUNDS = 4
export const MAX_WIDGET_CHAT_REQUEST_BYTES = 256 * 1024
export const MAX_WIDGET_CHAT_MESSAGE_BYTES = 8 * 1024
export const MAX_WIDGET_CHAT_HISTORY_MESSAGES = 20
export const MAX_WIDGET_CHAT_HISTORY_MESSAGE_BYTES = 5 * 1024
export const MAX_WIDGET_CHAT_HISTORY_BYTES = 64 * 1024
export const MAX_WIDGET_SESSION_REQUEST_BYTES = 64 * 1024
export const MAX_WIDGET_SESSION_SLIDES_VIEWED = 100
export const DEFAULT_BROWSER_VISITOR_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1_000

export interface ToolAuthorizationContext {
  call: ClientToolCall
  tool: ClientToolDefinition
  orgSlug: string
  sessionId: string
  round: number
  surface: 'chat' | 'voice'
  conversationId?: string
  /** Aborts when the turn is cancelled or its signed capability is about to expire. */
  signal: AbortSignal
}

export type ToolCallAuthorizer = (
  context: ToolAuthorizationContext,
) => boolean | Promise<boolean>

export interface ConvincedClientOptions {
  orgSlug: string
  apiBase?: string
  widgetToken?: string
  fetch?: typeof fetch
  tools?: ClientToolRegistry | ClientTool[]
  /** Required to execute tools whose manifest consent is session or per_call. */
  authorizeToolCall?: ToolCallAuthorizer
  /** May reduce, but never exceed, the protocol maximum of four continuation rounds. */
  maxClientToolRounds?: number
  defaultChatContext?: SendMessageOptions['context']
}

export class ConvincedSdkError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ConvincedSdkError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export class ConvincedClient {
  readonly orgSlug: string
  readonly apiBase: string
  readonly tools: ClientToolRegistry

  private readonly widgetToken?: string
  private readonly fetchImpl: typeof fetch
  private readonly events = new TypedEventEmitter<ConvincedClientEventMap>()
  private readonly authorizeToolCall?: ToolCallAuthorizer
  private readonly maxClientToolRounds: number
  private readonly defaultChatContext: SendMessageOptions['context']
  private readonly sessionToolConsent = new Set<ClientTool>()
  private readonly behaviorEvents: WidgetBehaviorEvent[] = []
  private readonly elevenLabsConversationIds = new Set<string>()
  private readonly demoRequestInFlight = new Map<string, Promise<WidgetDemoRequestResponse>>()
  private readonly completedDemoRequests = new Map<string, WidgetDemoRequestResponse>()
  private readonly sessionFingerprint: string
  private lastSessionInput: WidgetSessionInput | null = null
  private visitorIdentity: VisitorIdentity | null = null
  private activeTurnController: AbortController | null = null
  private initializePromise: Promise<ConvincedClientState> | null = null
  private endSessionPromise: Promise<Record<string, unknown>> | null = null
  private endSessionId: string | null = null
  private stateValue: ConvincedClientState = {
    status: 'idle',
    config: null,
    session: null,
    slides: [],
    slideMetadata: {},
    messages: [],
    identity: null,
    error: null,
    activeTurnId: null,
  }

  constructor(options: ConvincedClientOptions) {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/i.test(options.orgSlug)) {
      throw new Error('orgSlug must contain only letters, numbers, and hyphens.')
    }
    this.orgSlug = options.orgSlug
    this.sessionFingerprint = browserVisitorKey(this.orgSlug)
    this.apiBase = normalizeApiBase(options.apiBase ?? DEFAULT_API_BASE)
    if (options.widgetToken) this.widgetToken = options.widgetToken
    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') throw new Error('ConvincedClient requires a fetch implementation.')
    this.fetchImpl = fetchImpl.bind(globalThis)
    this.tools = options.tools instanceof ClientToolRegistry
      ? options.tools
      : new ClientToolRegistry(options.tools ?? [])
    if (options.authorizeToolCall) this.authorizeToolCall = options.authorizeToolCall
    this.maxClientToolRounds = Math.min(
      MAX_CLIENT_TOOL_ROUNDS,
      Math.max(0, Math.floor(options.maxClientToolRounds ?? MAX_CLIENT_TOOL_ROUNDS)),
    )
    this.defaultChatContext = options.defaultChatContext ?? {}
  }

  get state(): ConvincedClientState {
    return snapshot(this.stateValue)
  }

  on<K extends ConvincedClientEventName>(
    event: K,
    listener: ConvincedClientEventListener<K>,
  ): () => void {
    return this.events.on(event, listener)
  }

  once<K extends ConvincedClientEventName>(
    event: K,
    listener: ConvincedClientEventListener<K>,
  ): () => void {
    return this.events.once(event, listener)
  }

  off<K extends ConvincedClientEventName>(
    event: K,
    listener: ConvincedClientEventListener<K>,
  ): void {
    this.events.off(event, listener)
  }

  registerTool(tool: ClientTool): () => void {
    return this.tools.register(tool)
  }

  initialize(options: InitializeOptions = {}): Promise<ConvincedClientState> {
    if (this.initializePromise) return this.initializePromise
    const operation = this.initializeInternal(options)
    this.initializePromise = operation
    void operation.finally(() => {
      if (this.initializePromise === operation) this.initializePromise = null
    }).catch(() => undefined)
    return operation
  }

  private async initializeInternal(options: InitializeOptions): Promise<ConvincedClientState> {
    this.assertUsable()
    this.patchState({ status: 'initializing', error: null })
    try {
      await this.getConfig()
      await this.createSession(options.session ?? browserSessionInput())
      if (options.loadMedia !== false && this.stateValue.config?.slidesEnabled !== false) {
        await Promise.all([this.getSlides(), this.getSlideMetadata()])
      }
      this.patchState({ status: 'ready', error: null })
      this.events.emit('ready', this.state)
      return this.state
    } catch (error) {
      this.fail(error)
      throw error
    }
  }

  async getConfig(): Promise<WidgetConfig> {
    this.assertUsable()
    const config = await readJsonResponse<WidgetConfig>(
      await this.request(`/api/widget/${encodeURIComponent(this.orgSlug)}/config`),
    )
    this.patchState({ config })
    return config
  }

  async createSession(input: WidgetSessionInput = {}): Promise<WidgetSessionResponse> {
    this.assertUsable()
    const previousSessionId = this.stateValue.session?.sessionId
    const sessionInput = sanitizeSessionInput(input)
    const sessionBody = JSON.stringify({
      ...sessionInput,
      fingerprint: sessionInput.fingerprint || this.sessionFingerprint,
    })
    assertByteLimit(
      sessionBody,
      MAX_WIDGET_SESSION_REQUEST_BYTES,
      'session_request_too_large',
      `session request must not exceed ${MAX_WIDGET_SESSION_REQUEST_BYTES} UTF-8 bytes.`,
    )
    const session = await readJsonResponse<WidgetSessionResponse>(
      await this.request(`/api/widget/${encodeURIComponent(this.orgSlug)}/session`, {
        method: 'POST',
        body: sessionBody,
      }),
    )
    this.lastSessionInput = cloneSessionInput(sessionInput)
    if (session.sessionId !== previousSessionId) {
      this.sessionToolConsent.clear()
      this.behaviorEvents.length = 0
      this.elevenLabsConversationIds.clear()
      this.demoRequestInFlight.clear()
      this.completedDemoRequests.clear()
      this.visitorIdentity = null
      this.endSessionPromise = null
      this.endSessionId = null
    }
    this.patchState({
      session,
      config: session.config,
      ...(session.sessionId !== previousSessionId
        ? { identity: null, messages: [], activeTurnId: null, error: null }
        : {}),
    })
    return session
  }

  /**
   * Start a fresh session with the same attribution input used for the current
   * one. Managed renderers use this after a terminal close so reopening never
   * writes to, or starts voice on, an already-ended session.
   */
  renewSession(): Promise<WidgetSessionResponse> {
    return this.createSession(this.lastSessionInput ?? browserSessionInput())
  }

  async getSlides(): Promise<SlideItem[]> {
    this.assertUsable()
    const response = await readJsonResponse<{ slides: SlideItem[] }>(
      await this.request(`/api/widget/${encodeURIComponent(this.orgSlug)}/slides`),
    )
    const slides = Array.isArray(response.slides) ? response.slides : []
    this.patchState({ slides })
    return slides
  }

  async getSlideMetadata(): Promise<Record<string, SlideMetadata>> {
    this.assertUsable()
    const response = await readJsonResponse<{ slides: SlideMetadata[] }>(
      await this.request(`/api/widget/${encodeURIComponent(this.orgSlug)}/slides/metadata`),
    )
    const slideMetadata = Object.fromEntries(
      (Array.isArray(response.slides) ? response.slides : [])
        .filter((slide) => slide && typeof slide.filename === 'string')
        .map((slide) => [slide.filename, slide]),
    )
    this.patchState({ slideMetadata })
    return slideMetadata
  }

  async captureIdentity(input: IdentityInput): Promise<IdentityResponse> {
    this.assertUsable()
    const sessionId = this.requireSessionId()
    const response = await readJsonResponse<IdentityResponse>(
      await this.request(`/api/widget/${encodeURIComponent(this.orgSlug)}/identity`, {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          ...input,
          fingerprint: input.fingerprint || this.sessionFingerprint,
        }),
        headers: this.sessionWriteHeaders(),
      }),
    )
    this.visitorIdentity = mergeIdentity(this.visitorIdentity, input)
    this.patchState({ identity: this.visitorIdentity })
    this.events.emit('identity', { input, response })
    return response
  }

  /** Read the optional, session-scoped company enrichment produced after identity capture. */
  async getVisitorIntel(): Promise<WidgetVisitorIntelResponse> {
    this.assertUsable()
    const sessionId = this.requireSessionId()
    return readJsonResponse<WidgetVisitorIntelResponse>(
      await this.request(
        `/api/widget/${encodeURIComponent(this.orgSlug)}/visitor-intel?sessionId=${encodeURIComponent(sessionId)}`,
        { headers: this.sessionWriteHeaders() },
      ),
    )
  }

  /**
   * Mint a short-lived private ElevenLabs WebRTC descriptor from Convinced.
   * The server resolves the configured agent; callers cannot override it.
   */
  async getVoiceCredential(): Promise<WidgetVoiceCredentialResponse> {
    this.assertUsable()
    const sessionId = this.requireSessionId()
    return readJsonResponse<WidgetVoiceCredentialResponse>(
      await this.request(
        `/api/widget/${encodeURIComponent(this.orgSlug)}/session/${encodeURIComponent(sessionId)}/voice-token`,
        {
          method: 'POST',
          headers: this.sessionWriteHeaders(),
          body: '{}',
        },
      ),
    )
  }

  /**
   * Report that a managed or custom renderer exposed its demo-request surface.
   * The lifecycle is observable immediately; authoritative timeline sync is
   * best-effort so an analytics outage cannot block the UI.
   */
  reportDemoRequestOpened(surface = 'custom'): void {
    this.assertUsable()
    const normalizedSurface = normalizeDemoRequestSurface(surface)
    this.emitDemoRequestLifecycle({ status: 'opened', surface: normalizedSurface })
  }

  /** Submit the durable in-widget handoff used when no external scheduling URL is configured. */
  async submitDemoRequest(input: WidgetDemoRequestInput): Promise<WidgetDemoRequestResponse> {
    this.assertUsable()
    const sessionId = this.requireSessionId()
    let normalized: WidgetDemoRequestInput
    try {
      normalized = normalizeDemoRequestInput(input)
    } catch (error) {
      this.emitDemoRequestLifecycle({
        status: 'failed',
        stage: 'submission',
        errorCode: 'invalid_demo_request',
        hasCompany: hasNonEmptyString(input.company),
        hasPhone: hasNonEmptyString(input.phone),
      })
      throw error
    }
    const requestKey = `${sessionId}:${JSON.stringify(normalized)}`
    const completed = this.completedDemoRequests.get(requestKey)
    if (completed) return completed
    const pending = this.demoRequestInFlight.get(requestKey)
    if (pending) return pending

    const operation = this.submitDemoRequestInternal(sessionId, normalized)
    this.demoRequestInFlight.set(requestKey, operation)
    try {
      const response = await operation
      this.completedDemoRequests.set(requestKey, response)
      return response
    } finally {
      if (this.demoRequestInFlight.get(requestKey) === operation) {
        this.demoRequestInFlight.delete(requestKey)
      }
    }
  }

  private async submitDemoRequestInternal(
    sessionId: string,
    input: WidgetDemoRequestInput,
  ): Promise<WidgetDemoRequestResponse> {
    let response: WidgetDemoRequestResponse
    try {
      response = await readJsonResponse<WidgetDemoRequestResponse>(
        await this.request(`/api/widget/${encodeURIComponent(this.orgSlug)}/demo-request`, {
          method: 'POST',
          headers: this.sessionWriteHeaders(),
          body: JSON.stringify({ sessionId, ...input }),
        }),
      )
    } catch (error) {
      this.emitDemoRequestLifecycle({
        status: 'failed',
        stage: 'submission',
        errorCode: demoRequestErrorCode(error),
        hasCompany: Boolean(input.company),
        hasPhone: Boolean(input.phone),
      })
      throw error
    }

    if (this.stateValue.session?.sessionId !== sessionId) {
      const error = new ConvincedSdkError(
        'demo_request_session_changed',
        'The widget session changed before the demo request finished.',
      )
      this.emitDemoRequestLifecycle({
        status: 'failed',
        stage: 'identity_sync',
        errorCode: error.code,
        hasCompany: Boolean(input.company),
        hasPhone: Boolean(input.phone),
      }, { persist: false })
      throw error
    }

    let identityLinked = false
    try {
      const identityInput: IdentityInput = {
        email: input.email,
        name: input.name,
        ...(input.company ? { company: input.company } : {}),
        ...(input.phone ? { phone: input.phone } : {}),
      }
      const acceptedVisitorId = demoRequestVisitorId(response)
      if (acceptedVisitorId) {
        identityLinked = true
        if (response.alreadySubmitted !== true) {
          const identityResponse: IdentityResponse = { visitorId: acceptedVisitorId }
          this.visitorIdentity = mergeIdentity(this.visitorIdentity, identityInput)
          this.patchState({ identity: this.visitorIdentity })
          this.events.emit('identity', { input: identityInput, response: identityResponse })
        }
      } else if (response.alreadySubmitted !== true) {
        // Backwards compatibility for the deployed endpoint, which accepted
        // a new lead but did not return or link its durable visitor identity.
        // Never send retry form values to identity capture: an older/mixed
        // backend may be acknowledging a different identity that already won
        // this session's idempotency claim.
        await this.captureIdentity(identityInput)
        identityLinked = true
      }
    } catch (error) {
      this.emitDemoRequestLifecycle({
        status: 'failed',
        stage: 'identity_sync',
        errorCode: demoRequestErrorCode(error),
        hasCompany: Boolean(input.company),
        hasPhone: Boolean(input.phone),
      })
      throw error
    }

    this.emitDemoRequestLifecycle({
      status: 'submitted',
      ...safeDemoRequestResponseFields(response),
      alreadySubmitted: response.alreadySubmitted === true,
      identityLinked,
      hasCompany: Boolean(input.company),
      hasPhone: Boolean(input.phone),
    })
    return response
  }

  /**
   * Persist host-known visitor identity. When an email is present, the default
   * path also calls the canonical identity endpoint so the session is linked to
   * the durable visitor record.
   */
  async identify(
    input: VisitorIdentity,
    options: { capture?: boolean } = {},
  ): Promise<IdentityResponse | null> {
    this.assertUsable()
    if (!this.stateValue.session) await this.initialize()
    const identity = sanitizeIdentity(input)
    if (Object.keys(identity).length === 0) {
      throw new Error('identify requires at least one supported identity field.')
    }
    this.visitorIdentity = mergeIdentity(this.visitorIdentity, identity)

    let response: IdentityResponse | null = null
    if (identity.email && options.capture !== false) {
      response = await this.captureIdentity({
        email: identity.email,
        ...(identity.name ? { name: identity.name } : {}),
        ...(identity.company ? { company: identity.company } : {}),
        ...(identity.phone ? { phone: identity.phone } : {}),
      })
    } else {
      this.patchState({ identity: this.visitorIdentity })
    }
    await this.updateSessionContext()
    return response
  }

  /** Managed-loader compatible alias that stores context without forcing email capture. */
  setIdentity(input: VisitorIdentity): Promise<IdentityResponse | null> {
    return this.identify(input, { capture: false })
  }

  /** Record a bounded host-page behavior event and sync the complete snapshot. */
  async track(name: string, props: JsonObject = {}): Promise<void> {
    this.assertUsable()
    if (!this.stateValue.session) await this.initialize()
    const eventName = normalizeEventName(name)
    const eventProps = boundedEventProps(props)
    this.behaviorEvents.push({
      name: eventName,
      ...(Object.keys(eventProps).length > 0 ? { props: eventProps } : {}),
      ts: Date.now(),
    })
    if (this.behaviorEvents.length > 50) {
      this.behaviorEvents.splice(0, this.behaviorEvents.length - 50)
    }
    await this.updateSessionContext()
  }

  /** Managed-loader compatible alias. */
  sendEvent(name: string, props: JsonObject = {}): Promise<void> {
    return this.track(name, props)
  }

  trackEvent(name: string, props: JsonObject = {}): Promise<void> {
    return this.track(name, props)
  }

  /** Track a same-document SPA route change for personalization and auditing. */
  async updatePage(input: {
    url?: string
    title?: string
    referrer?: string
  } = {}): Promise<void> {
    const browserUrl = typeof window !== 'undefined' ? window.location.href : undefined
    const browserTitle = typeof document !== 'undefined' ? document.title : undefined
    const browserReferrer = typeof document !== 'undefined' ? document.referrer : undefined
    const pageUrl = input.url ?? browserUrl
    const referrer = input.referrer ?? browserReferrer
    await this.track('page_view', compactJsonObject({
      url: pageUrl ? privacySafeSessionUrl(pageUrl) : undefined,
      title: input.title ?? browserTitle,
      referrer: referrer ? privacySafeSessionUrl(referrer) : undefined,
    }))
  }

  async updateSessionContext(input: UpdateSessionContextInput = {}): Promise<void> {
    this.assertUsable()
    const sessionId = this.requireSessionId()
    const body: JsonObject = {
      events: toJsonValue(input.events ?? this.behaviorEvents),
      ...(input.identity === null
        ? { identity: null }
        : input.identity !== undefined
          ? { identity: toJsonValue(sanitizeIdentity(input.identity)) }
          : this.visitorIdentity
            ? { identity: toJsonValue(this.visitorIdentity) }
            : {}),
      ...(input.voiceUpgrade === true ? { voiceUpgrade: true } : {}),
      ...(input.voiceUpgradeAt ? { voiceUpgradeAt: input.voiceUpgradeAt } : {}),
      ...(input.pillsMessages ? { pillsMessages: toJsonValue(input.pillsMessages) } : {}),
    }
    await readJsonResponse<{ ok: boolean }>(
      await this.request(
        `/api/widget/${encodeURIComponent(this.orgSlug)}/session/${encodeURIComponent(sessionId)}/context`,
        { method: 'POST', body: JSON.stringify(body), headers: this.sessionWriteHeaders() },
      ),
    )
  }

  async markVoiceUpgrade(
    pillsMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  ): Promise<void> {
    await this.updateSessionContext({
      voiceUpgrade: true,
      voiceUpgradeAt: new Date().toISOString(),
      pillsMessages,
    })
  }

  /** Remember an ElevenLabs conversation id for session-end transcript linking. */
  linkElevenLabsConversation(conversationId: string): void {
    const id = conversationId.trim()
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) {
      throw new Error('ElevenLabs conversation id is invalid.')
    }
    this.elevenLabsConversationIds.add(id)
  }

  async endSession(options: EndWidgetSessionOptions = {}): Promise<Record<string, unknown>> {
    this.assertUsable()
    const sessionId = this.requireSessionId()
    if (this.endSessionPromise && this.endSessionId === sessionId) return this.endSessionPromise
    const operation = this.endSessionInternal(sessionId, options)
    this.endSessionId = sessionId
    this.endSessionPromise = operation
    try {
      return await operation
    } catch (error) {
      if (this.endSessionPromise === operation) {
        this.endSessionPromise = null
        this.endSessionId = null
      }
      throw error
    }
  }

  private async endSessionInternal(
    sessionId: string,
    options: EndWidgetSessionOptions,
  ): Promise<Record<string, unknown>> {
    const suppliedIds = options.elevenLabsConversationIds ?? []
    for (const id of suppliedIds) this.linkElevenLabsConversation(id)
    if (options.elevenLabsConversationId) {
      this.linkElevenLabsConversation(options.elevenLabsConversationId)
    }
    const allConversationIds = [...this.elevenLabsConversationIds]
    const latestConversationId = options.elevenLabsConversationId ?? allConversationIds.at(-1)
    const identity = this.visitorIdentity
    const clientMessages = options.clientMessages ?? this.stateValue.messages.map((message) => ({
      role: message.role,
      content: message.text,
    }))
    const slidesViewed = Array.from(new Set(
      (Array.isArray(options.slidesViewed) ? options.slidesViewed : [])
        .flatMap((slide) => boundedSessionString(slide, 512) ?? []),
    )).slice(-MAX_WIDGET_SESSION_SLIDES_VIEWED)
    return readJsonResponse<Record<string, unknown>>(
      await this.request(`/api/widget/${encodeURIComponent(this.orgSlug)}/session/end`, {
        method: 'POST',
        headers: this.sessionWriteHeaders(),
        body: JSON.stringify({
          sessionId,
          clientMessages,
          ...(slidesViewed.length > 0 ? { slidesViewed } : {}),
          ...(latestConversationId ? { elevenLabsConversationId: latestConversationId } : {}),
          ...(allConversationIds.length > 0 ? { elevenLabsConversationIds: allConversationIds } : {}),
          ...(options.email ?? identity?.email ? { email: options.email ?? identity?.email } : {}),
          ...(options.name ?? identity?.name ? { name: options.name ?? identity?.name } : {}),
          ...(options.company ?? identity?.company ? { company: options.company ?? identity?.company } : {}),
        }),
      }),
    )
  }

  async sendMessage(message: string, options: SendMessageOptions = {}): Promise<ChatMessage> {
    this.assertUsable()
    const trimmed = message.trim()
    if (!trimmed) throw new Error('message must not be empty.')
    assertByteLimit(
      trimmed,
      MAX_WIDGET_CHAT_MESSAGE_BYTES,
      'message_too_large',
      `message must not exceed ${MAX_WIDGET_CHAT_MESSAGE_BYTES} UTF-8 bytes.`,
    )
    if (this.activeTurnController) {
      throw new ConvincedSdkError('turn_in_progress', 'A chat turn is already in progress.')
    }
    if (!this.stateValue.session) await this.initialize()
    const sessionId = this.requireSessionId()
    const history = options.history ?? this.stateValue.messages
      .slice(-MAX_WIDGET_CHAT_HISTORY_MESSAGES)
      .map(toHistoryMessage)
    validateChatHistory(history)
    const userMessage = createMessage('user', trimmed)
    const assistantMessage = createMessage('assistant', '')
    this.appendMessage(userMessage)
    this.appendMessage(assistantMessage, false)
    const clientTools = this.tools.definitions()
    const clientTurnId = clientTools.length > 0 ? protocolTurnId() : null
    const seenClientToolCallIds = new Set<string>()
    const accumulatedClientToolResults: ClientToolResult[] = []

    const controller = new AbortController()
    this.activeTurnController = controller
    const abortFromCaller = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) abortFromCaller()
    else options.signal?.addEventListener('abort', abortFromCaller, { once: true })
    this.patchState({
      status: 'streaming',
      error: null,
      activeTurnId: assistantMessage.id,
    })

    let fullText = ''
    let sawProfileGate = false
    let continuation:
      | {
          clientToolCapability: string
          expiresAt?: string | number
        }
      | undefined
    let continuationRounds = 0

    try {
      while (true) {
        throwIfAborted(controller.signal)
        const body = {
          ...sessionChatContext(this.stateValue),
          ...this.defaultChatContext,
          ...(options.context ?? {}),
          sessionId,
          message: trimmed,
          history,
          clientTools: clientTools.length > 0 ? clientTools : undefined,
          clientTurnId: clientTools.length > 0 ? clientTurnId : undefined,
          resumeClientTurn: continuation ? true : undefined,
          clientToolCapability: continuation?.clientToolCapability,
          clientToolResults: continuation ? accumulatedClientToolResults : undefined,
        }
        const serializedBody = JSON.stringify(body)
        assertByteLimit(
          serializedBody,
          MAX_WIDGET_CHAT_REQUEST_BYTES,
          'chat_request_too_large',
          `chat request must not exceed ${MAX_WIDGET_CHAT_REQUEST_BYTES} UTF-8 bytes.`,
        )
        const requestDeadline = capabilityExecutionSignal(controller.signal, continuation?.expiresAt)
        let response: Response
        try {
          response = await this.request(`/api/widget/${encodeURIComponent(this.orgSlug)}/chat`, {
            method: 'POST',
            body: serializedBody,
            headers: this.sessionWriteHeaders(),
            signal: requestDeadline.signal,
          })
          throwIfAborted(requestDeadline.signal)
        } finally {
          requestDeadline.dispose()
        }
        if (!response.ok) throw await apiError(response)

        const pendingCalls: Array<{ turnId: string; call: ClientToolCall }> = []
        let pause: SseClientToolPauseEvent | null = null

        for await (const event of iterateSse(response, controller.signal)) {
          if (event === SSE_DONE) break
          this.events.emit('raw_event', event)

          if (isClientToolCallEvent(event)) {
            const call = normalizeToolCall(event.call, this.tools)
            const normalizedEvent: SseClientToolCallEvent = {
              type: 'client_tool_call',
              turnId: requiredTurnId(event.turnId),
              call,
            }
            pendingCalls.push({ turnId: normalizedEvent.turnId, call })
            this.events.emit('client_tool_call', normalizedEvent)
            continue
          }
          if (event.type === 'client_tool_pause') {
            pause = normalizePause(event)
            this.events.emit('client_tool_pause', pause)
            continue
          }
          if (typeof (event as { delta?: unknown }).delta === 'string') {
            const delta = (event as { delta: string }).delta
            fullText += delta
            this.updateAssistant(assistantMessage.id, fullText)
            this.events.emit('message_delta', {
              messageId: assistantMessage.id,
              delta,
              text: fullText,
            })
            continue
          }
          if (event.type === 'activity_start' || event.type === 'activity_step' || event.type === 'activity_complete' || event.type === 'profile_gate') {
            if (event.type === 'profile_gate') sawProfileGate = true
            this.events.emit('activity', event as ConvincedClientEventMap['activity'])
            continue
          }
          if ('error' in event && typeof event.error === 'string') {
            throw new ConvincedSdkError(
              typeof event.code === 'string' ? event.code : 'stream_error',
              event.error,
              event,
            )
          }
        }
        throwIfAborted(controller.signal)

        if (!pause) break
        if (!pause.capability) {
          throw new ConvincedSdkError(
            'missing_client_tool_capability',
            'The server paused for client tools without a signed continuation capability.',
          )
        }
        if (pendingCalls.length === 0) {
          throw new ConvincedSdkError(
            'missing_client_tool_calls',
            'The server paused a turn without sending client tool calls.',
          )
        }
        if (!clientTurnId || pause.turnId !== clientTurnId) {
          throw new ConvincedSdkError(
            'client_tool_turn_mismatch',
            'The paused client tool turn did not match the turn started by this client.',
          )
        }
        if (pendingCalls.some(({ turnId }) => turnId !== clientTurnId)) {
          throw new ConvincedSdkError(
            'client_tool_turn_mismatch',
            'A client tool call did not match the paused turn.',
          )
        }
        if (pendingCalls.length > MAX_HOST_TOOLS) {
          throw new ConvincedSdkError(
            'client_tool_batch_limit',
            `A continuation round may request at most ${MAX_HOST_TOOLS} client tool calls.`,
          )
        }
        for (const { call } of pendingCalls) {
          if (seenClientToolCallIds.has(call.id)) {
            throw new ConvincedSdkError(
              'duplicate_client_tool_call',
              `Client tool call id "${call.id}" was repeated in the same continuation chain.`,
            )
          }
          seenClientToolCallIds.add(call.id)
        }
        if (seenClientToolCallIds.size > MAX_HOST_TOOL_CALLS_PER_TURN) {
          throw new ConvincedSdkError(
            'client_tool_call_limit',
            `A continuation chain may execute at most ${MAX_HOST_TOOL_CALLS_PER_TURN} client tool calls.`,
          )
        }
        if (continuationRounds >= this.maxClientToolRounds) {
          throw new ConvincedSdkError(
            'client_tool_round_limit',
            `The client tool loop exceeded ${this.maxClientToolRounds} continuation rounds.`,
          )
        }

        this.patchState({ status: 'paused' })
        const results: ClientToolResult[] = []
        const capabilityExecution = capabilityExecutionSignal(controller.signal, pause.expiresAt)
        try {
          for (const { call } of pendingCalls) {
            throwIfAborted(capabilityExecution.signal)
            const result = await this.executeToolCall(
              call,
              pause.turnId,
              continuationRounds,
              capabilityExecution.signal,
            )
            throwIfAborted(capabilityExecution.signal)
            results.push(result)
            this.events.emit('client_tool_result', result)
          }
          throwIfAborted(capabilityExecution.signal)
        } finally {
          capabilityExecution.dispose()
        }
        accumulatedClientToolResults.push(...results)
        continuation = {
          clientToolCapability: pause.capability,
          ...(pause.expiresAt !== undefined ? { expiresAt: pause.expiresAt } : {}),
        }
        continuationRounds += 1
        this.patchState({ status: 'streaming' })
      }

      if (!fullText && sawProfileGate) {
        this.removeMessage(assistantMessage.id)
        this.patchState({ status: 'ready', activeTurnId: null, error: null })
        return assistantMessage
      }

      const content = parseAssistantContent(fullText, {
        slides: this.stateValue.slides,
        slideMetadata: this.stateValue.slideMetadata,
        videos: this.stateValue.session?.recommendedVideos ?? [],
      })
      const complete = { ...assistantMessage, text: fullText, content }
      this.replaceMessage(complete)
      this.events.emit('content', { messageId: complete.id, content })
      this.events.emit('message', complete)
      this.patchState({ status: 'ready', activeTurnId: null, error: null })
      return complete
    } catch (error) {
      const normalizedError = controller.signal.aborted
        ? abortError(controller.signal)
        : error
      if (fullText) {
        this.replaceMessage({
          ...assistantMessage,
          text: fullText,
          content: parseAssistantContent(fullText, {
            slides: this.stateValue.slides,
            slideMetadata: this.stateValue.slideMetadata,
            videos: this.stateValue.session?.recommendedVideos ?? [],
          }),
        })
      } else {
        this.removeMessage(assistantMessage.id)
      }
      this.fail(normalizedError)
      throw normalizedError
    } finally {
      options.signal?.removeEventListener('abort', abortFromCaller)
      if (this.activeTurnController === controller) this.activeTurnController = null
    }
  }

  cancelActiveTurn(reason = 'Cancelled by host application.'): void {
    this.activeTurnController?.abort(new ConvincedSdkError('turn_cancelled', reason))
  }

  destroy(): void {
    if (this.stateValue.status === 'destroyed') return
    this.cancelActiveTurn('Client destroyed.')
    this.sessionToolConsent.clear()
    this.behaviorEvents.length = 0
    this.elevenLabsConversationIds.clear()
    this.demoRequestInFlight.clear()
    this.completedDemoRequests.clear()
    this.visitorIdentity = null
    this.patchState({ status: 'destroyed', activeTurnId: null })
    this.events.clear()
  }

  private async executeToolCall(
    call: ClientToolCall,
    turnId: string,
    round: number,
    signal: AbortSignal,
  ): Promise<ClientToolResult> {
    const tool = this.tools.get(call.name)
    if (tool && !(await this.isToolCallAuthorized(call, tool, round, signal))) {
      return {
        version: HOST_TOOL_PROTOCOL_VERSION,
        callId: call.id,
        name: call.name,
        args: call.args,
        ok: false,
        error: {
          code: 'consent_denied',
          message: `Host application denied client tool "${call.name}".`,
        },
        durationMs: 0,
      }
    }
    return this.tools.execute(call, {
      orgSlug: this.orgSlug,
      sessionId: this.stateValue.session?.sessionId ?? null,
      turnId,
      surface: 'chat',
      signal,
    })
  }

  private async isToolCallAuthorized(
    call: ClientToolCall,
    tool: ClientTool,
    round: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (tool.consent === 'none') return true
    if (tool.consent === 'session' && this.sessionToolConsent.has(tool)) return true
    if (!this.authorizeToolCall) return false
    const allowed = await raceWithSignal(
      Promise.resolve(this.authorizeToolCall({
        call,
        tool,
        orgSlug: this.orgSlug,
        sessionId: this.requireSessionId(),
        round,
        surface: 'chat',
        signal,
      })),
      signal,
    )
    if (allowed && tool.consent === 'session') this.sessionToolConsent.add(tool)
    return allowed
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    if (this.widgetToken) headers.set('x-widget-token', this.widgetToken)
    return this.fetchImpl(`${this.apiBase}${path}`, { ...init, headers })
  }

  private sessionWriteHeaders(): Headers {
    const headers = new Headers()
    const capability = this.stateValue.session?.sessionCapability
    if (typeof capability === 'string' && capability.trim()) {
      headers.set('x-widget-session-capability', capability.trim())
    }
    return headers
  }

  private requireSessionId(): string {
    const sessionId = this.stateValue.session?.sessionId
    if (!sessionId) throw new ConvincedSdkError('session_required', 'Initialize or create a session first.')
    return sessionId
  }

  private assertUsable(): void {
    if (this.stateValue.status === 'destroyed') {
      throw new ConvincedSdkError('client_destroyed', 'This ConvincedClient has been destroyed.')
    }
  }

  private appendMessage(message: ChatMessage, emitCompletedEvent = true): void {
    this.stateValue = { ...this.stateValue, messages: [...this.stateValue.messages, message] }
    if (emitCompletedEvent) this.events.emit('message', message)
    this.events.emit('state', this.state)
  }

  private removeMessage(id: string): void {
    this.stateValue = {
      ...this.stateValue,
      messages: this.stateValue.messages.filter((message) => message.id !== id),
    }
    this.events.emit('state', this.state)
  }

  private replaceMessage(message: ChatMessage): void {
    this.stateValue = {
      ...this.stateValue,
      messages: this.stateValue.messages.map((item) => (item.id === message.id ? message : item)),
    }
    this.events.emit('state', this.state)
  }

  private updateAssistant(id: string, text: string): void {
    const content = parseAssistantContent(text, {
      slides: this.stateValue.slides,
      slideMetadata: this.stateValue.slideMetadata,
      videos: this.stateValue.session?.recommendedVideos ?? [],
    })
    this.replaceMessage({
      ...(this.stateValue.messages.find((message) => message.id === id) ?? createMessage('assistant', text)),
      id,
      text,
      content,
    })
  }

  private patchState(patch: Partial<ConvincedClientState>): void {
    this.stateValue = { ...this.stateValue, ...patch }
    this.events.emit('state', this.state)
  }

  private emitDemoRequestLifecycle(
    event: WidgetDemoRequestLifecycleEvent,
    options: { persist?: boolean } = {},
  ): void {
    this.events.emit('demo_request', event)
    if (options.persist === false) return
    const props: JsonObject = event.status === 'opened'
      ? { surface: event.surface }
      : event.status === 'submitted'
        ? compactJsonObject({
            requestId: event.requestId,
            submittedAt: event.submittedAt,
            alreadySubmitted: event.alreadySubmitted,
            identityLinked: event.identityLinked,
            hasCompany: event.hasCompany,
            hasPhone: event.hasPhone,
          })
        : {
            stage: event.stage,
            errorCode: event.errorCode,
            hasCompany: event.hasCompany,
            hasPhone: event.hasPhone,
          }
    void this.track(`demo_request_${event.status}`, props).catch(() => {
      // Lifecycle remains observable and the accepted handoff remains a
      // success even when best-effort timeline persistence is unavailable.
    })
  }

  private fail(error: unknown): void {
    if (this.stateValue.status === 'destroyed') return
    const normalized = error instanceof Error ? error : new Error(String(error))
    this.patchState({ status: 'error', error: normalized, activeTurnId: null })
    this.events.emit('error', normalized)
  }
}

function normalizeToolCall(value: unknown, registry: ClientToolRegistry): ClientToolCall {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new ConvincedSdkError('invalid_client_tool_call', 'Client tool call must be an object.')
  }
  const record = value as Record<string, unknown>
  if (record.version !== undefined && record.version !== HOST_TOOL_PROTOCOL_VERSION) {
    throw new ConvincedSdkError('invalid_client_tool_call', 'Client tool call protocol version is invalid.')
  }
  if (record.locality !== undefined && record.locality !== 'host') {
    throw new ConvincedSdkError('invalid_client_tool_call', 'Client tool call locality must be host.')
  }
  if (
    record.effect !== undefined &&
    record.effect !== 'read' &&
    record.effect !== 'navigate' &&
    record.effect !== 'mutate'
  ) {
    throw new ConvincedSdkError('invalid_client_tool_call', 'Client tool call effect is invalid.')
  }
  if (
    record.consent !== undefined &&
    record.consent !== 'none' &&
    record.consent !== 'session' &&
    record.consent !== 'per_call'
  ) {
    throw new ConvincedSdkError('invalid_client_tool_call', 'Client tool call consent is invalid.')
  }
  const name = typeof record.name === 'string' ? record.name : ''
  const manifest = registry.get(name)
  const rawArgs = record.args ?? record.arguments
  let args: JsonObject
  if (typeof rawArgs === 'string') {
    try {
      const parsed: unknown = JSON.parse(rawArgs)
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error()
      args = parsed as JsonObject
    } catch {
      throw new ConvincedSdkError('invalid_client_tool_args', 'Client tool args must be a JSON object.')
    }
  } else if (rawArgs && !Array.isArray(rawArgs) && typeof rawArgs === 'object') {
    args = rawArgs as JsonObject
  } else {
    throw new ConvincedSdkError('invalid_client_tool_args', 'Client tool args must be an object.')
  }
  const call: ClientToolCall = {
    version: HOST_TOOL_PROTOCOL_VERSION,
    id: typeof record.id === 'string' ? record.id : '',
    name,
    args,
    locality: 'host',
    effect: record.effect === 'read' || record.effect === 'navigate' || record.effect === 'mutate'
      ? record.effect
      : manifest?.effect ?? 'mutate',
    consent: record.consent === 'none' || record.consent === 'session' || record.consent === 'per_call'
      ? record.consent
      : manifest?.consent ?? 'per_call',
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(call.id)) {
    throw new ConvincedSdkError('invalid_client_tool_call', 'Client tool call id is invalid.')
  }
  if (!/^(?:host|client)_[a-z0-9_]+$/.test(call.name) || call.name.length > 64) {
    throw new ConvincedSdkError('invalid_client_tool_call', 'Client tool call name is invalid.')
  }
  return call
}

function normalizePause(event: WidgetSseEvent): SseClientToolPauseEvent {
  const record = event as Record<string, unknown>
  const capability = typeof record.capability === 'string' ? record.capability : ''
  if (!capability) {
    throw new ConvincedSdkError(
      'missing_client_tool_capability',
      'The server paused for client tools without a signed continuation capability.',
    )
  }
  return {
    type: 'client_tool_pause',
    turnId: requiredTurnId(record.turnId),
    capability,
    ...(typeof record.expiresAt === 'string' || typeof record.expiresAt === 'number'
      ? { expiresAt: record.expiresAt }
      : {}),
  }
}

function isClientToolCallEvent(
  event: WidgetSseEvent,
): event is SseClientToolCallEvent & { call: unknown } {
  return event.type === 'client_tool_call' && 'call' in event
}

function requiredTurnId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128) {
    throw new ConvincedSdkError('invalid_client_turn_id', 'Client tool turnId is invalid.')
  }
  return value
}

function createMessage(role: 'user' | 'assistant', text: string): ChatMessage {
  return {
    id: randomId(role),
    role,
    text,
    content: [{ type: 'text', text }],
    createdAt: Date.now(),
  }
}

function randomId(prefix: string): string {
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`
  return `${prefix}_${id}`
}

function randomSdkVisitorKey(): string {
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`
  return `sdk_${id}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)
}

interface StoredBrowserVisitorKey {
  id: string
  createdAt: number
  lastSeenAt: number
}

function browserVisitorStorageKey(orgSlug: string): string {
  return `convinced-sdk-visitor-${orgSlug}-v1`
}

function browserVisitorKey(orgSlug: string): string {
  const fallback = randomSdkVisitorKey()
  if (typeof localStorage === 'undefined') return fallback
  const now = Date.now()
  const storageKey = browserVisitorStorageKey(orgSlug)
  try {
    // Older managed widgets stored names, emails, and conversation topics in
    // the customer's origin. The SDK now retains only this opaque key.
    localStorage.removeItem(legacyManagedVisitorStorageKey(orgSlug))
    const raw = localStorage.getItem(storageKey)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredBrowserVisitorKey>
      const storedId = parsed.id
      const validId = typeof storedId === 'string' && /^sdk_[A-Za-z0-9_-]{1,124}$/.test(storedId)
      const validCreatedAt = Number.isFinite(parsed.createdAt) && Number(parsed.createdAt) > 0
      if (
        validId &&
        validCreatedAt &&
        now - Number(parsed.createdAt) <= DEFAULT_BROWSER_VISITOR_KEY_TTL_MS
      ) {
        localStorage.setItem(storageKey, JSON.stringify({
          id: storedId!,
          createdAt: Number(parsed.createdAt),
          lastSeenAt: now,
        } satisfies StoredBrowserVisitorKey))
        return storedId!
      }
    }
    localStorage.setItem(storageKey, JSON.stringify({
      id: fallback,
      createdAt: now,
      lastSeenAt: now,
    } satisfies StoredBrowserVisitorKey))
  } catch {
    // Storage can be unavailable in hardened/private browser contexts. A
    // per-client opaque key still keeps the current session correctly bound.
  }
  return fallback
}

/** Remove every browser-storage record owned by the SDK for this org. */
export function forgetBrowserVisitorKey(orgSlug: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/i.test(orgSlug)) {
    throw new Error('orgSlug must contain only letters, numbers, and hyphens.')
  }
  try {
    localStorage?.removeItem(browserVisitorStorageKey(orgSlug))
    localStorage?.removeItem(legacyManagedVisitorStorageKey(orgSlug))
  } catch {
    // Deletion is best-effort when browser storage is unavailable.
  }
}

function legacyManagedVisitorStorageKey(orgSlug: string): string {
  return `convinced-visitor-${orgSlug}`
}

function toHistoryMessage(message: ChatMessage): ChatHistoryMessage {
  return { role: message.role, content: message.text }
}

export function resolveWidgetSessionAttribution(
  source: string | URL,
  explicit: Pick<BrowserSessionInputOptions, 'c' | 'pid'> = {},
): WidgetSessionAttribution {
  const url = source instanceof URL ? new URL(source.href) : new URL(source)
  const utmData: Record<string, string> = {}
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const value = url.searchParams.get(key)
    const safe = safeAttributionValue(value)
    if (safe) utmData[key] = safe
  }
  const campaignFromPath = url.pathname.match(/\/for\/([a-z0-9-]{1,64})(?:\/|$)/i)?.[1]
  const pid = boundedSessionString(
    explicit.pid || url.searchParams.get('pid') || url.searchParams.get('cid'),
    128,
  )
  const campaignToken = normalizeCampaignToken(
    explicit.c ||
    url.searchParams.get('c') ||
    campaignFromPath ||
    url.searchParams.get('utm_campaign') ||
    '',
  )
  return {
    ...(Object.keys(utmData).length > 0 ? { utmData } : {}),
    ...(pid ? { pid } : {}),
    ...(campaignToken ? { c: campaignToken } : {}),
  }
}

export function browserSessionInput(options: BrowserSessionInputOptions = {}): WidgetSessionInput {
  const browserUrl = typeof window !== 'undefined' && window.location
    ? window.location.href
    : undefined
  const source = options.url ?? browserUrl
  if (!source) {
    const campaignToken = normalizeCampaignToken(options.c ?? '')
    return {
      ...(boundedSessionString(options.fingerprint, 128) ? { fingerprint: boundedSessionString(options.fingerprint, 128) } : {}),
      ...(boundedSessionString(options.pid, 128) ? { pid: boundedSessionString(options.pid, 128) } : {}),
      ...(campaignToken ? { c: campaignToken } : {}),
    }
  }
  const url = source instanceof URL ? new URL(source.href) : new URL(source)
  const attribution = resolveWidgetSessionAttribution(url, options)
  const pageTitle = options.pageTitle ?? (
    typeof document !== 'undefined' ? document.title : undefined
  )
  const referrer = options.referrer ?? (
    typeof document !== 'undefined' ? document.referrer : undefined
  )
  return {
    pageUrl: privacySafeSessionUrl(url),
    ...(boundedSessionString(pageTitle, 256) ? { pageTitle: boundedSessionString(pageTitle, 256) } : {}),
    ...(referrer ? { referrer: privacySafeSessionUrl(referrer) } : {}),
    ...(boundedSessionString(options.fingerprint, 128) ? { fingerprint: boundedSessionString(options.fingerprint, 128) } : {}),
    ...attribution,
  }
}

function privacySafeSessionUrl(value: string | URL): string {
  try {
    const url = value instanceof URL ? new URL(value.href) : new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    return `${url.origin}${url.pathname}`.slice(0, 2_048)
  } catch {
    return ''
  }
}

export function normalizeCampaignToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
}

function sessionChatContext(state: ConvincedClientState): SendMessageOptions['context'] {
  const session = state.session
  if (!session) return {}
  return {
    ...(typeof session.knowledgeKit === 'string' ? { knowledgeKit: session.knowledgeKit } : {}),
    ...(session.recommendedSlides !== undefined && session.recommendedSlides !== null
      ? { recommendedSlides: session.recommendedSlides }
      : {}),
    ...(session.recommendedVideos !== undefined && session.recommendedVideos !== null
      ? { recommendedVideos: session.recommendedVideos }
      : {}),
    ...(state.slides.length > 0 ? { slides: state.slides } : {}),
    ...(Object.keys(state.slideMetadata).length > 0 ? { slideMetadata: state.slideMetadata } : {}),
  }
}

function sanitizeIdentity(input: VisitorIdentity): VisitorIdentity {
  const limits: Record<keyof VisitorIdentity, number> = {
    email: 320,
    name: 128,
    company: 128,
    industry: 128,
    role: 128,
    phone: 64,
    title: 128,
  }
  const identity: VisitorIdentity = {}
  for (const key of Object.keys(limits) as Array<keyof VisitorIdentity>) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) {
      identity[key] = value.trim().slice(0, limits[key])
    }
  }
  return identity
}

function mergeIdentity(
  current: VisitorIdentity | null,
  next: VisitorIdentity,
): VisitorIdentity {
  return { ...(current ?? {}), ...sanitizeIdentity(next) }
}

function normalizeDemoRequestInput(input: WidgetDemoRequestInput): WidgetDemoRequestInput {
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 128) : ''
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase().slice(0, 320) : ''
  if (name.length < 2) throw new Error('Demo request name must contain at least two characters.')
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new Error('Demo request requires a valid email.')
  const phone = typeof input.phone === 'string' ? input.phone.trim().slice(0, 32) : ''
  const company = typeof input.company === 'string' ? input.company.trim().slice(0, 128) : ''
  const context = typeof input.context === 'string' ? input.context.trim().slice(0, 1_000) : ''
  return {
    name,
    email,
    ...(phone ? { phone } : {}),
    ...(company ? { company } : {}),
    ...(context ? { context } : {}),
  }
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && Boolean(value.trim())
}

function normalizeDemoRequestSurface(surface: string): string {
  const normalized = surface.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error('Demo request surface must be 1-64 safe characters.')
  }
  return normalized
}

function demoRequestVisitorId(response: WidgetDemoRequestResponse): string | null {
  const candidate = response.visitorId
  if (typeof candidate !== 'string') return null
  const visitorId = candidate.trim()
  return /^[A-Za-z0-9_-]{1,256}$/.test(visitorId) ? visitorId : null
}

function safeDemoRequestResponseFields(
  response: WidgetDemoRequestResponse,
): Pick<Extract<WidgetDemoRequestLifecycleEvent, { status: 'submitted' }>, 'requestId' | 'submittedAt'> {
  const requestId = typeof response.requestId === 'string' &&
    /^[A-Za-z0-9_-]{1,256}$/.test(response.requestId.trim())
    ? response.requestId.trim()
    : undefined
  const submittedAt = typeof response.submittedAt === 'string' &&
    response.submittedAt.length <= 64 &&
    Number.isFinite(Date.parse(response.submittedAt))
    ? response.submittedAt
    : undefined
  return {
    ...(requestId ? { requestId } : {}),
    ...(submittedAt ? { submittedAt } : {}),
  }
}

function demoRequestErrorCode(error: unknown): string {
  const candidate = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  if (typeof candidate === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(candidate)) {
    return candidate
  }
  return 'demo_request_failed'
}

function normalizeEventName(name: string): string {
  const normalized = name.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(normalized)) {
    throw new Error('Event names must be 1-128 letters, numbers, dots, colons, underscores, or hyphens.')
  }
  return normalized
}

function boundedEventProps(props: JsonObject): JsonObject {
  if (!props || Array.isArray(props) || typeof props !== 'object') {
    throw new Error('Event props must be a JSON object.')
  }
  const bounded = Object.fromEntries(Object.entries(props).slice(0, 10))
  let serialized: string
  try {
    serialized = JSON.stringify(bounded)
  } catch {
    throw new Error('Event props must be JSON-serializable.')
  }
  if (new TextEncoder().encode(serialized).byteLength > 16 * 1024) {
    throw new Error('Event props exceed 16384 bytes.')
  }
  return JSON.parse(serialized) as JsonObject
}

function compactJsonObject(
  input: Record<string, string | number | boolean | null | undefined>,
): JsonObject {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string | number | boolean | null] =>
      entry[1] !== undefined),
  )
}

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) return null
  return JSON.parse(serialized) as JsonValue
}

function protocolTurnId(): string {
  const value = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)
}

function snapshot(state: ConvincedClientState): ConvincedClientState {
  return {
    ...state,
    slides: [...state.slides],
    slideMetadata: { ...state.slideMetadata },
    messages: [...state.messages],
  }
}

function cloneSessionInput(input: WidgetSessionInput): WidgetSessionInput {
  return {
    ...input,
    ...(input.utmData ? { utmData: { ...input.utmData } } : {}),
    ...(input.utm ? { utm: { ...input.utm } } : {}),
  }
}

function sanitizeSessionInput(input: WidgetSessionInput): WidgetSessionInput {
  const pageUrl = input.pageUrl ? privacySafeSessionUrl(input.pageUrl) : ''
  const referrer = input.referrer ? privacySafeSessionUrl(input.referrer) : ''
  const pageTitle = boundedSessionString(input.pageTitle, 256)
  const fingerprint = boundedSessionString(input.fingerprint, 128)
  const pid = boundedSessionString(input.pid, 128)
  const c = normalizeCampaignToken(typeof input.c === 'string' ? input.c : '')
  const utmData = sanitizeUtmRecord(input.utmData, true)
  const utm = sanitizeUtmRecord(input.utm)
  return {
    ...(pageUrl ? { pageUrl } : {}),
    ...(pageTitle ? { pageTitle } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(referrer ? { referrer } : {}),
    ...(pid ? { pid } : {}),
    ...(c ? { c } : {}),
    ...(Object.keys(utmData).length > 0 ? { utmData } : {}),
    ...(Object.keys(utm).length > 0 ? { utm } : {}),
  }
}

function sanitizeUtmRecord(value: unknown, allowRef = false): Record<string, string> {
  if (!value || Array.isArray(value) || typeof value !== 'object') return {}
  const allowed = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    ...(allowRef ? ['ref'] : []),
  ])
  return Object.fromEntries(Object.entries(value).flatMap(([key, rawValue]) => {
    if (!allowed.has(key)) return []
    const safe = safeAttributionValue(rawValue)
    return safe ? [[key, safe]] : []
  }))
}

function safeAttributionValue(value: unknown): string {
  const normalized = boundedSessionString(value, 256)
  if (!normalized || /@|\b(?:token|secret|password|reset|email)\b/i.test(normalized)) return ''
  return normalized.replace(/[^a-zA-Z0-9._~:/+\- ]/g, '').slice(0, 256)
}

function boundedSessionString(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

const CAPABILITY_EXPIRY_SAFETY_MS = 2_000

function capabilityExecutionSignal(
  turnSignal: AbortSignal,
  expiresAt?: string | number,
): { signal: AbortSignal; dispose(): void } {
  if (expiresAt === undefined) {
    return { signal: turnSignal, dispose() {} }
  }

  const expiryMs = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt)
  if (!Number.isFinite(expiryMs) || expiryMs <= 0) {
    throw new ConvincedSdkError(
      'invalid_client_tool_capability_expiry',
      'The server returned an invalid client tool capability expiry.',
    )
  }

  const controller = new AbortController()
  const abortFromTurn = () => controller.abort(abortError(turnSignal))
  if (turnSignal.aborted) abortFromTurn()
  else turnSignal.addEventListener('abort', abortFromTurn, { once: true })

  const remainingMs = expiryMs - Date.now() - CAPABILITY_EXPIRY_SAFETY_MS
  const expire = () => controller.abort(new ConvincedSdkError(
    'client_tool_capability_expired',
    'The client tool capability expired before all host actions could be resumed.',
  ))
  const timeout = remainingMs <= 0 ? undefined : setTimeout(expire, remainingMs)
  if (remainingMs <= 0) expire()

  return {
    signal: controller.signal,
    dispose() {
      if (timeout) clearTimeout(timeout)
      turnSignal.removeEventListener('abort', abortFromTurn)
    },
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}

function abortError(signal: AbortSignal): ConvincedSdkError {
  if (signal.reason instanceof ConvincedSdkError) return signal.reason
  const message = signal.reason instanceof Error
    ? signal.reason.message
    : typeof signal.reason === 'string' && signal.reason
      ? signal.reason
      : 'The active chat turn was cancelled.'
  return new ConvincedSdkError('turn_cancelled', message, signal.reason)
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup()
      reject(abortError(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function validateChatHistory(history: ChatHistoryMessage[]): void {
  if (!Array.isArray(history)) {
    throw new ConvincedSdkError('invalid_chat_history', 'history must be an array.')
  }
  if (history.length > MAX_WIDGET_CHAT_HISTORY_MESSAGES) {
    throw new ConvincedSdkError(
      'chat_history_too_long',
      `history must contain at most ${MAX_WIDGET_CHAT_HISTORY_MESSAGES} messages.`,
    )
  }
  let totalBytes = 0
  for (const [index, item] of history.entries()) {
    if (
      !item ||
      (item.role !== 'user' && item.role !== 'assistant') ||
      typeof item.content !== 'string'
    ) {
      throw new ConvincedSdkError(
        'invalid_chat_history',
        `history[${index}] must contain a user or assistant role and string content.`,
      )
    }
    const contentBytes = utf8ByteLength(item.content)
    if (contentBytes > MAX_WIDGET_CHAT_HISTORY_MESSAGE_BYTES) {
      throw new ConvincedSdkError(
        'chat_history_message_too_large',
        `history[${index}].content must not exceed ${MAX_WIDGET_CHAT_HISTORY_MESSAGE_BYTES} UTF-8 bytes.`,
      )
    }
    totalBytes += contentBytes
  }
  if (totalBytes > MAX_WIDGET_CHAT_HISTORY_BYTES) {
    throw new ConvincedSdkError(
      'chat_history_too_large',
      `history content must not exceed ${MAX_WIDGET_CHAT_HISTORY_BYTES} UTF-8 bytes in total.`,
    )
  }
}

function assertByteLimit(
  value: string,
  maximum: number,
  code: string,
  message: string,
): void {
  if (utf8ByteLength(value) > maximum) throw new ConvincedSdkError(code, message)
}

function utf8ByteLength(value: string): number {
  return typeof TextEncoder === 'undefined'
    ? value.length
    : new TextEncoder().encode(value).byteLength
}

export { ConvincedApiError }

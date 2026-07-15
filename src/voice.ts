import type { PartialOptions as ElevenLabsPartialOptions } from '@elevenlabs/client'
import { TypedEventEmitter } from './events.js'
import { ClientToolRegistry } from './tools/registry.js'
import {
  MAX_HOST_TOOLS,
  type ClientTool,
  type ClientToolExecutionAuthorizer,
  type ClientToolResult,
  type JsonObject,
} from './types.js'

export type ElevenLabsConnectionType = 'websocket' | 'webrtc'
export const MAX_ELEVENLABS_INIT_CONTEXT_BYTES = 32 * 1024

export interface ElevenLabsVoiceDescriptorBase {
  provider?: 'elevenlabs'
  connectionType?: ElevenLabsConnectionType
  dynamicVariables?: Record<string, string | number | boolean>
  overrides?: JsonObject
  textOnly?: boolean
  userId?: string
  environment?: string
  useWakeLock?: boolean
  /** ElevenLabs tool name -> registered Convinced host/client tool name. */
  exactClientTools?: Record<string, string>
  /** Enabled by default as `host_extension_call`; set false when the agent has no gateway tool. */
  genericClientTool?: false | { name?: string }
}

export type ElevenLabsVoiceDescriptor = ElevenLabsVoiceDescriptorBase & (
  | {
      agentId: string
      signedUrl?: never
      conversationToken?: never
    }
  | {
      signedUrl: string
      agentId?: never
      conversationToken?: never
      connectionType?: 'websocket'
    }
  | {
      conversationToken: string
      agentId?: never
      signedUrl?: never
      connectionType?: 'webrtc'
    }
)

export type ElevenLabsVoiceStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'
  | 'error'

export type ElevenLabsVoiceMode = 'speaking' | 'listening'

export interface ElevenLabsVoiceMessage {
  message: string
  source: 'user' | 'ai'
  role: 'user' | 'agent'
  event_id?: number
}

export interface ConvincedVoiceState {
  status: ElevenLabsVoiceStatus
  mode: ElevenLabsVoiceMode | null
  muted: boolean
  /** True when audio startup failed and the managed opt-in text transport connected. */
  textOnly: boolean
  pushToTalkActive: boolean
  conversationId: string | null
  error: Error | null
}

export interface ElevenLabsConversationLike {
  endSession(): Promise<void>
  getId(): string
  setMicMuted(isMuted: boolean): void
  setVolume?(options: { volume: number }): void
  sendContextualUpdate(text: string, options?: { contextId?: string }): void
  sendUserMessage(text: string): void
  sendUserActivity(): void
  isOpen?(): boolean
}

export interface ElevenLabsStartSessionOptions {
  agentId?: string
  signedUrl?: string
  conversationToken?: string
  connectionType?: ElevenLabsConnectionType
  dynamicVariables?: Record<string, string | number | boolean>
  overrides?: JsonObject
  textOnly: boolean
  userId?: string
  environment?: string
  useWakeLock?: boolean
  clientTools: Record<
    string,
    (parameters: unknown) => string | number | void | Promise<string | number | void>
  >
  onConnect?: (props: { conversationId: string }) => void
  onDisconnect?: (details: unknown) => void
  onError?: (message: string, context?: unknown) => void
  onMessage?: (message: ElevenLabsVoiceMessage) => void
  onModeChange?: (props: { mode: ElevenLabsVoiceMode }) => void
  onStatusChange?: (props: { status: Exclude<ElevenLabsVoiceStatus, 'idle' | 'error'> }) => void
  onAudio?: (base64Audio: string) => void
  onVadScore?: (props: { vadScore: number }) => void
}

export type ElevenLabsConversationFactory = (
  options: ElevenLabsStartSessionOptions,
) => Promise<ElevenLabsConversationLike>

export interface ElevenLabsVoiceDescriptorFactoryContext {
  orgSlug: string
  sessionId: string | null
  /** Aborts when the pending voice start is cancelled or superseded. */
  signal: AbortSignal
}

/**
 * Resolve a complete browser-safe descriptor immediately before each start.
 * Use this for expiring signedUrl/conversationToken credentials. The result is
 * validated with the same browser API-key and credential rules as a static
 * descriptor.
 */
export type ElevenLabsVoiceDescriptorFactory = (
  context: ElevenLabsVoiceDescriptorFactoryContext,
) => ElevenLabsVoiceDescriptor | Promise<ElevenLabsVoiceDescriptor>

/** Per-start context layered over the resolved descriptor by an adapter. */
export interface ConvincedVoiceStartContext {
  dynamicVariables?: Record<string, string | number | boolean>
  overrides?: JsonObject
  /** Mute the transport immediately on creation; used for first-hold PTT. */
  startMuted?: boolean
  /** Retry one startup failure without audio. Capacity/policy failures do not retry. */
  fallbackToTextOnly?: boolean
  /** Fallback bindings. Descriptor-owned bindings win on name conflicts. */
  exactClientTools?: Record<string, string>
}

export interface VoiceClientToolEvent {
  elevenLabsToolName: string
  registryToolName: string
  arguments: JsonObject | string
}

export interface VoiceClientToolResultEvent extends VoiceClientToolEvent {
  result: ClientToolResult
}

export interface ConvincedVoiceControllerEventMap {
  state: ConvincedVoiceState
  message: ElevenLabsVoiceMessage
  client_tool_call: VoiceClientToolEvent
  client_tool_result: VoiceClientToolResultEvent
  error: Error
}

export type ConvincedVoiceControllerEventName = keyof ConvincedVoiceControllerEventMap
export type ConvincedVoiceControllerEventListener<K extends ConvincedVoiceControllerEventName> = (
  payload: ConvincedVoiceControllerEventMap[K],
) => void

export interface ConvincedVoiceControllerOptions {
  /** Static descriptor, or a fallback/default when descriptorFactory is used. */
  descriptor?: ElevenLabsVoiceDescriptor
  /** Called for every start/reconnect so private credentials cannot expire while idle. */
  descriptorFactory?: ElevenLabsVoiceDescriptorFactory
  tools: ClientToolRegistry
  orgSlug: string
  sessionId?: string | null | (() => string | null)
  authorizeToolCall?: ClientToolExecutionAuthorizer
  conversationFactory?: ElevenLabsConversationFactory
  onStatusChange?: (state: ConvincedVoiceState) => void
  onModeChange?: (mode: ElevenLabsVoiceMode, state: ConvincedVoiceState) => void
  onMessage?: (message: ElevenLabsVoiceMessage) => void
  onConnect?: (conversationId: string) => void
  onConversationId?: (conversationId: string) => void
  onDisconnect?: (details: unknown) => void
  onError?: (error: Error, context?: unknown) => void
  onAudio?: (base64Audio: string) => void
  onVadScore?: (score: number) => void
  onClientToolCall?: (event: VoiceClientToolEvent) => void
  onClientToolResult?: (event: VoiceClientToolResultEvent) => void
}

/**
 * Framework-neutral, voice-first adapter over ElevenLabs Conversational AI.
 * The host supplies a server-created public/signed descriptor; browser API keys
 * are rejected. All page/MCP actions still execute through ClientToolRegistry.
 */
export class ConvincedVoiceController {
  readonly descriptor: ElevenLabsVoiceDescriptor | undefined
  readonly tools: ClientToolRegistry
  readonly orgSlug: string

  private readonly options: ConvincedVoiceControllerOptions
  private readonly factory: ElevenLabsConversationFactory
  private readonly events = new TypedEventEmitter<ConvincedVoiceControllerEventMap>()
  private readonly sessionConsent = new Set<ClientTool>()
  private readonly runtimeTools = new ClientToolRegistry()
  private conversation: ElevenLabsConversationLike | null = null
  private executionController = new AbortController()
  private startPromise: Promise<ConvincedVoiceState> | null = null
  private endPromise: Promise<void> | null = null
  private lifecycleGeneration = 0
  private transportAttemptGeneration = 0
  private stateValue: ConvincedVoiceState = {
    status: 'idle',
    mode: null,
    muted: false,
    textOnly: false,
    pushToTalkActive: false,
    conversationId: null,
    error: null,
  }

  constructor(options: ConvincedVoiceControllerOptions) {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/i.test(options.orgSlug)) {
      throw new Error('orgSlug must contain only letters, numbers, and hyphens.')
    }
    if (!options.descriptor && !options.descriptorFactory) {
      throw new Error('Voice requires a descriptor or descriptorFactory.')
    }
    if (options.descriptor) validateDescriptor(options.descriptor)
    this.options = options
    this.descriptor = options.descriptor
    this.tools = options.tools
    this.orgSlug = options.orgSlug
    this.factory = options.conversationFactory ?? defaultConversationFactory
  }

  get state(): ConvincedVoiceState {
    return { ...this.stateValue }
  }

  get conversationId(): string | null {
    return this.stateValue.conversationId
  }

  on<K extends ConvincedVoiceControllerEventName>(
    event: K,
    listener: ConvincedVoiceControllerEventListener<K>,
  ): () => void {
    return this.events.on(event, listener)
  }

  once<K extends ConvincedVoiceControllerEventName>(
    event: K,
    listener: ConvincedVoiceControllerEventListener<K>,
  ): () => void {
    return this.events.once(event, listener)
  }

  off<K extends ConvincedVoiceControllerEventName>(
    event: K,
    listener: ConvincedVoiceControllerEventListener<K>,
  ): void {
    this.events.off(event, listener)
  }

  /** Subscribe to state after construction; immediately receives the current snapshot. */
  subscribe(listener: (state: ConvincedVoiceState) => void): () => void {
    listener(this.state)
    return this.on('state', listener)
  }

  /**
   * Register a bounded adapter-local tool without adding it to the chat tool
   * manifest. The managed renderer uses this for presentation and identity UI;
   * headless callers can continue to use the primary registry unchanged.
   */
  registerRuntimeTool(tool: ClientTool): () => void {
    return this.runtimeTools.register(tool)
  }

  async start(context: ConvincedVoiceStartContext = {}): Promise<ConvincedVoiceState> {
    if (this.startPromise) return this.startPromise
    if (this.conversation && this.stateValue.status !== 'disconnected') {
      throw new Error('An ElevenLabs voice session is already active.')
    }
    const generation = ++this.lifecycleGeneration
    this.executionController = new AbortController()
    this.sessionConsent.clear()
    this.updateState({
      status: 'connecting',
      mode: null,
      muted: context.startMuted === true,
      textOnly: false,
      pushToTalkActive: false,
      conversationId: null,
      error: null,
    })

    const startPromise = this.startInternal(generation, context)
    this.startPromise = startPromise
    try {
      return await startPromise
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null
    }
  }

  async end(): Promise<void> {
    if (this.endPromise) return this.endPromise
    const endPromise = this.endInternal()
    this.endPromise = endPromise
    try {
      await endPromise
    } finally {
      if (this.endPromise === endPromise) this.endPromise = null
    }
  }

  setMuted(muted: boolean): void {
    const conversation = this.requireConversation()
    conversation.setMicMuted(muted)
    this.updateState({ muted, ...(muted ? { pushToTalkActive: false } : {}) })
  }

  startPushToTalk(): void {
    if (this.stateValue.textOnly) {
      throw new Error('Push-to-talk is unavailable in text-only fallback mode.')
    }
    const conversation = this.requireConversation()
    conversation.setMicMuted(false)
    this.updateState({ muted: false, pushToTalkActive: true })
    conversation.sendUserActivity()
  }

  stopPushToTalk(): void {
    const conversation = this.requireConversation()
    conversation.setMicMuted(true)
    this.updateState({ muted: true, pushToTalkActive: false })
  }

  setVolume(volume: number): void {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      throw new Error('volume must be a number from 0 to 1.')
    }
    const conversation = this.requireConversation()
    if (!conversation.setVolume) throw new Error('The active ElevenLabs transport does not support volume control.')
    conversation.setVolume({ volume })
  }

  sendContextualUpdate(text: string, contextId?: string): void {
    const message = boundedText(text, 'contextual update', 8_000)
    this.requireConversation().sendContextualUpdate(
      message,
      contextId ? { contextId: boundedText(contextId, 'contextId', 128) } : undefined,
    )
  }

  sendUserMessage(text: string): void {
    this.requireConversation().sendUserMessage(boundedText(text, 'user message', 4_000))
  }

  sendUserActivity(): void {
    this.requireConversation().sendUserActivity()
  }

  private async startInternal(
    generation: number,
    context: ConvincedVoiceStartContext,
  ): Promise<ConvincedVoiceState> {
    try {
      let descriptor = await this.resolveDescriptor()
      if (!this.isCurrentGeneration(generation)) return this.state
      let attempt = ++this.transportAttemptGeneration
      let conversation: ElevenLabsConversationLike
      let textOnly = descriptor.textOnly === true
      const primaryStartOptions = this.buildStartOptions(descriptor, context, generation, attempt)
      try {
        conversation = await this.factory(primaryStartOptions)
      } catch (primaryError) {
        if (
          !context.fallbackToTextOnly ||
          descriptor.textOnly === true ||
          !isRecoverableAudioStartupError(primaryError) ||
          !this.isCurrentTransport(generation, attempt)
        ) throw primaryError
        attempt = ++this.transportAttemptGeneration
        descriptor = this.options.descriptorFactory
          ? await this.resolveDescriptor()
          : descriptor
        if (!this.isCurrentTransport(generation, attempt)) return this.state
        const fallbackOverrides = mergeJsonObjects(descriptor.overrides, {
          conversation: { textOnly: true },
        })
        descriptor = {
          ...descriptor,
          textOnly: true,
          ...(fallbackOverrides ? { overrides: fallbackOverrides } : {}),
        }
        textOnly = true
        this.updateState({ status: 'connecting', muted: true, textOnly: true, error: null })
        conversation = await this.factory(this.buildStartOptions(descriptor, context, generation, attempt))
      }
      if (context.startMuted === true || textOnly) safeCall(() => conversation.setMicMuted(true))
      if (textOnly && conversation.setVolume) safeCall(() => conversation.setVolume?.({ volume: 0 }))
      if (!this.isCurrentTransport(generation, attempt)) {
        silenceConversation(conversation)
        await safeEndConversation(conversation)
        if (this.stateValue.status !== 'error') {
          this.updateState({
            status: 'disconnected',
            mode: null,
            muted: true,
            textOnly: false,
            pushToTalkActive: false,
          })
        }
        return this.state
      }
      this.conversation = conversation
      const conversationId = safeConversationId(conversation.getId())
      if (conversationId) this.recordConversationId(conversationId)
      if (this.stateValue.status === 'connecting') {
        this.updateState({
          status: 'connected',
          muted: context.startMuted === true || textOnly,
          textOnly,
        })
      } else if (this.stateValue.status === 'connected') {
        this.updateState({ muted: context.startMuted === true || textOnly, textOnly })
      }
      return this.state
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      if (!this.isCurrentGeneration(generation)) {
        if (this.stateValue.status !== 'error') {
          this.updateState({
            status: 'disconnected',
            mode: null,
            muted: true,
            textOnly: false,
            pushToTalkActive: false,
          })
        }
        return this.state
      }
      this.executionController.abort(normalized)
      this.updateState({ status: 'error', muted: true, textOnly: false, error: normalized, pushToTalkActive: false })
      this.events.emit('error', normalized)
      safeCall(() => this.options.onError?.(normalized))
      throw normalized
    }
  }

  private async endInternal(): Promise<void> {
    ++this.lifecycleGeneration
    const pendingStart = this.startPromise
    const conversation = this.conversation
    this.executionController.abort(new Error('Voice session ended.'))
    this.sessionConsent.clear()

    if (conversation || pendingStart) {
      this.updateState({
        status: 'disconnecting',
        muted: true,
        pushToTalkActive: false,
      })
    }
    let closeError: unknown = null
    if (conversation) {
      silenceConversation(conversation)
      try {
        await conversation.endSession()
      } catch (error) {
        closeError = error
      } finally {
        if (this.conversation === conversation) this.conversation = null
      }
    }
    if (pendingStart) {
      // A cancelled factory may still resolve a live transport. startInternal
      // detects the superseded generation, silences it, and closes it before
      // this end call resolves.
      await pendingStart.catch(() => undefined)
    }
    this.conversation = null
    if (this.stateValue.status !== 'idle' || pendingStart || conversation) {
      this.updateState({
        status: 'disconnected',
        mode: null,
        muted: true,
        textOnly: false,
        pushToTalkActive: false,
      })
    }
    if (closeError) throw closeError
  }

  private async resolveDescriptor(): Promise<ElevenLabsVoiceDescriptor> {
    const descriptor = this.options.descriptorFactory
      ? await this.options.descriptorFactory({
          orgSlug: this.orgSlug,
          sessionId: this.resolveSessionId(),
          signal: this.executionController.signal,
        })
      : this.descriptor
    if (!descriptor) throw new Error('Voice descriptor factory did not provide a descriptor.')
    validateDescriptor(descriptor)
    return descriptor
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.lifecycleGeneration && !this.executionController.signal.aborted
  }

  private isCurrentTransport(generation: number, attempt: number): boolean {
    return this.isCurrentGeneration(generation) && attempt === this.transportAttemptGeneration
  }

  private buildStartOptions(
    descriptor: ElevenLabsVoiceDescriptor,
    context: ConvincedVoiceStartContext,
    generation: number,
    attempt: number,
  ): ElevenLabsStartSessionOptions {
    const clientTools = this.buildClientTools(descriptor, context)
    const dynamicVariables = {
      ...(descriptor.dynamicVariables ?? {}),
      ...(context.dynamicVariables ?? {}),
    }
    const overrides = mergeJsonObjects(descriptor.overrides, context.overrides)
    assertInitContextBudget(dynamicVariables, overrides)
    const options: ElevenLabsStartSessionOptions = {
      ...('agentId' in descriptor && descriptor.agentId ? { agentId: descriptor.agentId } : {}),
      ...('signedUrl' in descriptor && descriptor.signedUrl ? { signedUrl: descriptor.signedUrl } : {}),
      ...('conversationToken' in descriptor && descriptor.conversationToken
        ? { conversationToken: descriptor.conversationToken }
        : {}),
      ...(descriptor.connectionType ? { connectionType: descriptor.connectionType } : {}),
      ...(Object.keys(dynamicVariables).length > 0 ? { dynamicVariables } : {}),
      ...(overrides ? { overrides } : {}),
      ...(descriptor.userId ? { userId: descriptor.userId } : {}),
      ...(descriptor.environment ? { environment: descriptor.environment } : {}),
      ...(descriptor.useWakeLock !== undefined ? { useWakeLock: descriptor.useWakeLock } : {}),
      textOnly: descriptor.textOnly ?? false,
      clientTools,
      onConnect: ({ conversationId }) => {
        if (!this.isCurrentTransport(generation, attempt)) return
        const id = safeConversationId(conversationId)
        if (id) this.recordConversationId(id)
        this.updateState({
          status: 'connected',
          textOnly: descriptor.textOnly === true,
          muted: descriptor.textOnly === true || context.startMuted === true,
        })
        if (id) safeCall(() => this.options.onConnect?.(id))
      },
      onDisconnect: (details) => {
        if (!this.isCurrentTransport(generation, attempt)) return
        ++this.lifecycleGeneration
        this.executionController.abort(new Error('ElevenLabs disconnected.'))
        this.sessionConsent.clear()
        this.conversation = null
        this.updateState({ status: 'disconnected', mode: null, muted: true, textOnly: false, pushToTalkActive: false })
        safeCall(() => this.options.onDisconnect?.(details))
      },
      onError: (message, context) => {
        if (!this.isCurrentTransport(generation, attempt)) return
        const error = new Error(message || 'ElevenLabs voice session failed.')
        ++this.lifecycleGeneration
        this.executionController.abort(error)
        this.sessionConsent.clear()
        const conversation = this.conversation
        this.conversation = null
        if (conversation) {
          silenceConversation(conversation)
          void safeEndConversation(conversation)
        }
        this.updateState({
          status: 'error',
          mode: null,
          muted: true,
          textOnly: false,
          pushToTalkActive: false,
          error,
        })
        this.events.emit('error', error)
        safeCall(() => this.options.onError?.(error, context))
      },
      onMessage: (message) => {
        if (!this.isCurrentTransport(generation, attempt)) return
        this.events.emit('message', message)
        safeCall(() => this.options.onMessage?.(message))
      },
      onModeChange: ({ mode }) => {
        if (!this.isCurrentTransport(generation, attempt)) return
        this.updateState({ mode })
        safeCall(() => this.options.onModeChange?.(mode, this.state))
      },
      onStatusChange: ({ status }) => {
        if (this.isCurrentTransport(generation, attempt)) this.updateState({ status })
      },
      onAudio: (base64Audio) => {
        if (this.isCurrentTransport(generation, attempt)) safeCall(() => this.options.onAudio?.(base64Audio))
      },
      onVadScore: ({ vadScore }) => {
        if (this.isCurrentTransport(generation, attempt)) safeCall(() => this.options.onVadScore?.(vadScore))
      },
    }
    return options
  }

  private buildClientTools(
    descriptor: ElevenLabsVoiceDescriptor,
    context: ConvincedVoiceStartContext,
  ): ElevenLabsStartSessionOptions['clientTools'] {
    const exact = {
      ...(context.exactClientTools ?? {}),
      ...(descriptor.exactClientTools ?? {}),
    }
    const exactEntries = Object.entries(exact)
    const genericClientTool = descriptor.genericClientTool
    const hasGenericGateway = genericClientTool !== false
    const maximumExactTools = MAX_HOST_TOOLS - (hasGenericGateway ? 1 : 0)
    if (exactEntries.length > maximumExactTools) {
      throw new Error(
        `Voice may bind at most ${maximumExactTools} exact client tools with the generic gateway ${hasGenericGateway ? 'enabled' : 'disabled'}.`,
      )
    }
    const callbacks: ElevenLabsStartSessionOptions['clientTools'] = {}
    for (const [elevenLabsName, registryName] of exactEntries) {
      validateElevenLabsToolName(elevenLabsName)
      if (!this.tools.has(registryName) && !this.runtimeTools.has(registryName)) {
        throw new Error(`Voice tool "${elevenLabsName}" maps to unregistered tool "${registryName}".`)
      }
      callbacks[elevenLabsName] = (parameters) => this.executeClientTool(
        elevenLabsName,
        registryName,
        normalizeArguments(parameters),
      )
    }

    if (genericClientTool !== false) {
      const gatewayName = genericClientTool?.name ?? 'host_extension_call'
      validateElevenLabsToolName(gatewayName)
      if (callbacks[gatewayName]) {
        throw new Error(`Generic voice gateway "${gatewayName}" conflicts with an exact client tool.`)
      }
      callbacks[gatewayName] = async (parameters) => {
        const gateway = parseGatewayArguments(parameters)
        if ('error' in gateway) {
          return JSON.stringify(toolObservation('host_tool', { ok: false, error: gateway.error }))
        }
        return this.executeClientTool(gatewayName, gateway.name, gateway.arguments)
      }
    }
    return callbacks
  }

  private async executeClientTool(
    elevenLabsToolName: string,
    registryToolName: string,
    arguments_: JsonObject | string,
  ): Promise<string> {
    const event: VoiceClientToolEvent = {
      elevenLabsToolName,
      registryToolName,
      arguments: arguments_,
    }
    this.events.emit('client_tool_call', event)
    safeCall(() => this.options.onClientToolCall?.(event))
    const conversationId = this.stateValue.conversationId
    const registry = this.runtimeTools.has(registryToolName) ? this.runtimeTools : this.tools
    const result = await registry.executeByName(
      registryToolName,
      arguments_,
      {
        orgSlug: this.orgSlug,
        sessionId: this.resolveSessionId(),
        turnId: voiceExecutionId('turn'),
        surface: 'voice',
        ...(conversationId ? { conversationId } : {}),
        signal: this.executionController.signal,
      },
      {
        callId: voiceExecutionId('call'),
        authorize: async (authorization) => {
          const registered = registry.get(registryToolName)
          if (registered?.consent === 'session' && this.sessionConsent.has(registered)) return true
          if (!this.options.authorizeToolCall) return false
          const allowed = await this.options.authorizeToolCall(authorization)
          if (allowed && registered?.consent === 'session') this.sessionConsent.add(registered)
          return allowed
        },
      },
    )
    const resultEvent = { ...event, result }
    this.events.emit('client_tool_result', resultEvent)
    safeCall(() => this.options.onClientToolResult?.(resultEvent))
    const registered = registry.get(registryToolName)
    const source = registered?.constraints?.adapter === 'mcp' ? 'mcp' : 'host_tool'
    return JSON.stringify(toolObservation(source, result))
  }

  private resolveSessionId(): string | null {
    const configured = this.options.sessionId
    return typeof configured === 'function' ? configured() : configured ?? null
  }

  private recordConversationId(conversationId: string): void {
    if (this.stateValue.conversationId === conversationId) return
    this.updateState({ conversationId })
    safeCall(() => this.options.onConversationId?.(conversationId))
  }

  private requireConversation(): ElevenLabsConversationLike {
    if (!this.conversation || this.stateValue.status !== 'connected') {
      throw new Error('Start and connect the ElevenLabs voice session first.')
    }
    return this.conversation
  }

  private updateState(patch: Partial<ConvincedVoiceState>): void {
    const previous = this.stateValue
    this.stateValue = { ...previous, ...patch }
    if (
      previous.status !== this.stateValue.status ||
      previous.mode !== this.stateValue.mode ||
      previous.muted !== this.stateValue.muted ||
      previous.textOnly !== this.stateValue.textOnly ||
      previous.pushToTalkActive !== this.stateValue.pushToTalkActive ||
      previous.conversationId !== this.stateValue.conversationId ||
      previous.error !== this.stateValue.error
    ) {
      this.events.emit('state', this.state)
      safeCall(() => this.options.onStatusChange?.(this.state))
    }
  }
}

async function defaultConversationFactory(
  options: ElevenLabsStartSessionOptions,
): Promise<ElevenLabsConversationLike> {
  const { Conversation } = await import('@elevenlabs/client')
  return Conversation.startSession(
    options as unknown as ElevenLabsPartialOptions,
  ) as Promise<ElevenLabsConversationLike>
}

function validateDescriptor(descriptor: ElevenLabsVoiceDescriptor): void {
  if (containsApiKey(descriptor)) {
    throw new Error('Never put an ElevenLabs API key in a browser descriptor; use agentId, signedUrl, or conversationToken.')
  }
  const record = descriptor as unknown as Record<string, unknown>
  const credentials = ['agentId', 'signedUrl', 'conversationToken'].filter(
    (key) => typeof record[key] === 'string' && Boolean((record[key] as string).trim()),
  )
  if (credentials.length !== 1) {
    throw new Error('Voice descriptor must contain exactly one of agentId, signedUrl, or conversationToken.')
  }
  if (typeof record.agentId === 'string' && record.agentId.length > 256) {
    throw new Error('ElevenLabs agentId is too long.')
  }
  if (typeof record.signedUrl === 'string') {
    const url = new URL(record.signedUrl)
    if (url.protocol !== 'wss:' && url.protocol !== 'https:') {
      throw new Error('ElevenLabs signedUrl must use wss or https.')
    }
    if (descriptor.connectionType && descriptor.connectionType !== 'websocket') {
      throw new Error('ElevenLabs signedUrl sessions require websocket transport.')
    }
  }
  if (typeof record.conversationToken === 'string' && descriptor.connectionType === 'websocket') {
    throw new Error('ElevenLabs conversationToken sessions require WebRTC transport.')
  }
  if (descriptor.dynamicVariables && Object.keys(descriptor.dynamicVariables).length > 128) {
    throw new Error('Voice descriptor may contain at most 128 dynamic variables.')
  }
}

function containsApiKey(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:xi[_-]?)?api[_-]?key$/i.test(key)) return true
    if (containsApiKey(child, seen)) return true
  }
  return false
}

function assertInitContextBudget(
  dynamicVariables: Record<string, string | number | boolean>,
  overrides: JsonObject | undefined,
): void {
  const serialized = JSON.stringify({ dynamicVariables, ...(overrides ? { overrides } : {}) })
  const bytes = typeof TextEncoder === 'undefined'
    ? serialized.length
    : new TextEncoder().encode(serialized).byteLength
  if (bytes > MAX_ELEVENLABS_INIT_CONTEXT_BYTES) {
    throw new Error(
      `ElevenLabs initialization context exceeds ${MAX_ELEVENLABS_INIT_CONTEXT_BYTES} bytes.`,
    )
  }
}

function toolObservation(
  source: 'host_tool' | 'mcp',
  observation: unknown,
): JsonObject {
  return {
    trust: 'untrusted_tool_observation',
    source,
    observation: observation as JsonObject,
  }
}

function validateElevenLabsToolName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name)) {
    throw new Error(`Invalid ElevenLabs client tool name "${name}".`)
  }
}

function normalizeArguments(value: unknown): JsonObject | string {
  if (typeof value === 'string') return value
  if (value && !Array.isArray(value) && typeof value === 'object') return value as JsonObject
  return '{}'
}

function parseGatewayArguments(value: unknown):
  | { name: string; arguments: JsonObject | string }
  | { error: { code: string; message: string } } {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return { error: { code: 'invalid_gateway_arguments', message: 'host_extension_call requires an object.' } }
  }
  const record = value as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name : ''
  if (!/^(?:host|client)_[a-z0-9_]{1,57}$/.test(name)) {
    return { error: { code: 'invalid_gateway_tool_name', message: 'Requested client tool name is invalid.' } }
  }
  const rawArguments = record.arguments_json ?? record.arguments ?? record.args ?? {}
  if (typeof rawArguments !== 'string' && (!rawArguments || Array.isArray(rawArguments) || typeof rawArguments !== 'object')) {
    return { error: { code: 'invalid_gateway_arguments', message: 'Requested client tool arguments are invalid.' } }
  }
  return { name, arguments: rawArguments as JsonObject | string }
}

function voiceExecutionId(prefix: string): string {
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`
  return `${prefix}_${id}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)
}

function safeConversationId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value) ? value : null
}

function isElevenLabsCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /maximum concurrent capacity|workspace limit|agent limit|\b4300\b/i.test(message)
}

function isRecoverableAudioStartupError(error: unknown): boolean {
  if (isElevenLabsCapacityError(error)) return false
  const name = error && typeof error === 'object' && 'name' in error
    ? String((error as { name?: unknown }).name ?? '').toLowerCase()
    : ''
  if (['notallowederror', 'notfounderror', 'notreadableerror', 'overconstrainederror', 'securityerror', 'aborterror'].includes(name)) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/\b(?:401|403|unauthori[sz]ed|forbidden|invalid (?:agent|token|credential|descriptor|configuration)|agent disabled|quota|capacity|concurrency)\b/i.test(message)) {
    return false
  }
  return /\b(?:microphone|mic|audio(?: input)?|media(?: device)?|getusermedia|webrtc|rtc|websocket|transport|network error|connection (?:failed|closed))\b/i.test(message)
}

function boundedText(value: string, label: string, maxLength: number): string {
  const text = value.trim()
  if (!text) throw new Error(`${label} must not be empty.`)
  if (text.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`)
  return text
}

function safeCall(callback: () => void): void {
  try {
    callback()
  } catch {
    // Host rendering callbacks must not interrupt the voice transport.
  }
}

function silenceConversation(conversation: ElevenLabsConversationLike): void {
  safeCall(() => conversation.setMicMuted(true))
  if (conversation.setVolume) safeCall(() => conversation.setVolume?.({ volume: 0 }))
}

async function safeEndConversation(conversation: ElevenLabsConversationLike): Promise<void> {
  try {
    await conversation.endSession()
  } catch {
    // A superseded transport is already detached from SDK state. Its close
    // failure must not resurrect it or overwrite the current lifecycle.
  }
}

function mergeJsonObjects(
  base: JsonObject | undefined,
  overlay: JsonObject | undefined,
): JsonObject | undefined {
  if (!base && !overlay) return undefined
  const result: JsonObject = { ...(base ?? {}) }
  for (const [key, value] of Object.entries(overlay ?? {})) {
    const prior = result[key]
    if (isJsonObject(prior) && isJsonObject(value)) {
      result[key] = mergeJsonObjects(prior, value) ?? {}
    } else {
      result[key] = value
    }
  }
  return result
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && !Array.isArray(value) && typeof value === 'object'
}

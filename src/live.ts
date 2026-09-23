import { TypedEventEmitter } from './events.js'

export const MAX_LIVE_CONTEXT_BYTES = 8 * 1024
const START_TIMEOUT_MS = 20_000
const CLOSE_TIMEOUT_MS = 15_000
const ICE_TIMEOUT_MS = 10_000
const TRANSCRIPT_IDLE_MS = 1_000
const DELEGATION_SETTLE_MS = 150
const DELEGATION_TRANSCRIPT_TIMEOUT_MS = 2_000

export type LiveStatus = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'disconnected' | 'error'
export type LiveMode = 'listening' | 'speaking' | 'overlap'

export interface LiveMessage {
  message: string
  source: 'user' | 'ai'
  role: 'user' | 'agent'
  eventId?: string
  startMs?: number
  endMs?: number
}

export interface LiveTranscriptDelta {
  delta: string
  source: LiveMessage['source']
  role: LiveMessage['role']
  startMs?: number
  endMs?: number
}

export interface LiveBackendMessage {
  message: string
  delegationId: string
  itemId?: string
}

export interface ConvincedLiveState {
  status: LiveStatus
  mode: LiveMode | null
  muted: boolean
  liveSessionId: string | null
  error: Error | null
}

export interface LiveSessionDescriptor {
  /** Host route that selects the models, prompts, knowledge, and credentials. */
  sessionUrl: string | (() => string)
  /** @internal Created by ConvincedClient from the signed session capability. */
  headers?: () => Record<string, string>
}

export interface LiveStartContext {
  /** Factual page/session context. Model configuration remains server-owned. */
  context?: string
  startMuted?: boolean
}

export interface LiveClientDelegation {
  delegationId: string
  transcript: string
  offsetMs?: number
}

export interface LiveClientDelegationResult {
  message: string
  /** Optional shorter faithful context for speech. Control directives are removed and UTF-8 size is bounded. */
  speech?: string
}

export interface ConvincedLiveControllerOptions {
  descriptor: LiveSessionDescriptor
  /** Test hook. Production callers should use ConvincedClient.createLiveController(). */
  fetch?: typeof fetch
  onStatusChange?: (state: ConvincedLiveState) => void
  onModeChange?: (mode: LiveMode, state: ConvincedLiveState) => void
  onMessage?: (message: LiveMessage) => void
  onBackendMessage?: (message: LiveBackendMessage) => void
  onConnect?: (liveSessionId: string) => void
  onLiveSessionId?: (liveSessionId: string) => void
  onDisconnect?: () => void
  onError?: (error: Error, context?: unknown) => void
  onClientDelegation?: (
    delegation: LiveClientDelegation,
  ) => LiveClientDelegationResult | Promise<LiveClientDelegationResult>
}

export interface ConvincedLiveControllerEventMap {
  state: ConvincedLiveState
  message: LiveMessage
  message_delta: LiveTranscriptDelta
  backend_message: LiveBackendMessage
  error: Error
}

type EventName = keyof ConvincedLiveControllerEventMap
type EventListener<K extends EventName> = (payload: ConvincedLiveControllerEventMap[K]) => void
type TranscriptBuffer = {
  text: string
  firstEventId?: string
  startMs?: number
  endMs?: number
  timer: ReturnType<typeof setTimeout> | null
}
type PendingDelegation = {
  delegation: LiveClientDelegation
  generation: number
  receivedAt: number
}
type ServerEvent = {
  type?: unknown
  event_id?: unknown
  delta?: unknown
  start_ms?: unknown
  end_ms?: unknown
  session?: { id?: unknown }
  error?: { message?: unknown }
  offset_ms?: unknown
  delegation?: { id?: unknown; target?: unknown }
  delegation_id?: unknown
}

/** Full-duplex GPT-Live WebRTC that delegates every turn to Convinced chat. */
export class ConvincedLiveController {
  private readonly events = new TypedEventEmitter<ConvincedLiveControllerEventMap>()
  private readonly handledDelegations = new Set<string>()
  private readonly fetchImpl: typeof fetch
  private abort = new AbortController()
  private peer: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private media: MediaStream | null = null
  private output: HTMLAudioElement | null = null
  private pendingStart: Promise<ConvincedLiveState> | null = null
  private generation = 0
  private inputActive = false
  private outputActive = false
  private readonly inputTranscript: TranscriptBuffer = { text: '', timer: null }
  private readonly outputTranscript: TranscriptBuffer = { text: '', timer: null }
  private sessionStarted: (() => void) | null = null
  private sessionStartFailed: ((error: Error) => void) | null = null
  private sessionClosed: (() => void) | null = null
  private readonly inputTranscriptSegments: string[] = []
  private readonly pendingDelegations: PendingDelegation[] = []
  private delegationTimer: ReturnType<typeof setTimeout> | null = null
  private lastInputTranscriptAt = 0
  private inputTranscriptEndMs: number | undefined
  private stateValue: ConvincedLiveState = {
    status: 'idle', mode: null, muted: false, liveSessionId: null, error: null,
  }

  constructor(private readonly options: ConvincedLiveControllerOptions) {
    validateDescriptor(options.descriptor)
    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') throw new Error('ConvincedLiveController requires fetch.')
    this.fetchImpl = fetchImpl.bind(globalThis)
  }

  get state(): ConvincedLiveState { return { ...this.stateValue } }
  get liveSessionId(): string | null { return this.stateValue.liveSessionId }

  on<K extends EventName>(event: K, listener: EventListener<K>): () => void {
    return this.events.on(event, listener)
  }

  subscribe(listener: (state: ConvincedLiveState) => void): () => void {
    listener(this.state)
    return this.on('state', listener)
  }

  start(context: LiveStartContext = {}): Promise<ConvincedLiveState> {
    if (this.pendingStart) return this.pendingStart
    if (this.peer) return Promise.reject(new Error('A live session is already active.'))
    const generation = ++this.generation
    this.abort = new AbortController()
    this.handledDelegations.clear()
    this.inputTranscriptSegments.length = 0
    this.pendingDelegations.length = 0
    if (this.delegationTimer) clearTimeout(this.delegationTimer)
    this.delegationTimer = null
    this.update({ status: 'connecting', mode: null, muted: context.startMuted === true, liveSessionId: null, error: null })
    const operation = this.startInternal(generation, context)
    this.pendingStart = operation
    void operation.finally(() => {
      if (this.pendingStart === operation) this.pendingStart = null
    }).catch(() => undefined)
    return operation
  }

  async end(): Promise<void> {
    const channel = this.channel
    if (!channel) {
      this.cleanup()
      if (this.stateValue.status !== 'idle') this.update({ status: 'disconnected', mode: null, muted: true })
      return
    }
    this.update({ status: 'disconnecting', muted: true })
    this.flushTranscripts()
    if (channel.readyState === 'open') {
      const closed = new Promise<void>((resolve) => { this.sessionClosed = resolve })
      channel.send(JSON.stringify({ type: 'session.close', event_id: id('close') }))
      await Promise.race([closed, delay(CLOSE_TIMEOUT_MS)])
    }
    ++this.generation
    this.abort.abort(new Error('Live session ended.'))
    this.handledDelegations.clear()
    this.cleanup()
    this.update({ status: 'disconnected', mode: null, muted: true })
    call(() => this.options.onDisconnect?.())
  }

  setMuted(muted: boolean): void {
    if (!this.media || this.stateValue.status !== 'connected') throw new Error('Start the live session first.')
    for (const track of this.media.getAudioTracks()) track.enabled = !muted
    this.send({
      type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute',
      event_id: id(muted ? 'mute' : 'unmute'),
    })
  }

  setVolume(volume: number): void {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('volume must be from 0 to 1.')
    if (!this.output) throw new Error('Start the live session first.')
    this.output.volume = volume
  }

  /** Give a verified backend result to GPT Live for natural spoken paraphrasing. */
  sendBackendResult(text: string, delegationId: string | null = null): void {
    const content = liveCommentary(text)
    this.send({
      type: 'session.commentary.append',
      event_id: id('commentary'),
      delegation_id: delegationId,
      content,
    })
  }

  sendContextualUpdate(text: string, contextId?: string): void {
    const context = bounded(text, 'context', MAX_LIVE_CONTEXT_BYTES)
    const prefix = contextId ? `[context:${bounded(contextId, 'contextId', 128)}]\n` : ''
    this.send({
      type: 'session.thinking.append',
      event_id: id('context'),
      delegation_id: null,
      content: `${prefix}${context}`,
    })
  }

  private async startInternal(generation: number, context: LiveStartContext): Promise<ConvincedLiveState> {
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      if (generation !== this.generation) { stop(media); return this.state }
      for (const track of media.getAudioTracks()) track.enabled = context.startMuted !== true

      const peer = new RTCPeerConnection()
      const channel = peer.createDataChannel('oai-events')
      const output = document.createElement('audio')
      output.autoplay = true
      this.media = media
      this.peer = peer
      this.channel = channel
      this.output = output
      peer.ontrack = (event) => {
        if (event.streams[0]) output.srcObject = event.streams[0]
        void output.play().catch(() => undefined)
      }
      for (const track of media.getTracks()) peer.addTrack(track, media)

      const started = deferred()
      this.sessionStarted = started.resolve
      this.sessionStartFailed = started.reject
      channel.onmessage = (message) => this.handleServerEvent(message.data, generation)
      channel.onerror = () => started.reject(new Error('Live data channel failed.'))
      channel.onclose = () => {
        if (generation !== this.generation || this.stateValue.status === 'disconnecting') return
        this.flushTranscripts()
        this.abort.abort(new Error('Live data channel closed.'))
        this.cleanup()
        this.update({ status: 'disconnected', mode: null, muted: true })
        call(() => this.options.onDisconnect?.())
      }

      await peer.setLocalDescription(await peer.createOffer())
      await gatherIce(peer)
      const sdp = peer.localDescription?.sdp
      if (!sdp) throw new Error('WebRTC did not create an SDP offer.')
      const sessionUrl = typeof this.options.descriptor.sessionUrl === 'function'
        ? this.options.descriptor.sessionUrl()
        : this.options.descriptor.sessionUrl
      validateSessionUrl(sessionUrl)
      const headers = safeHeaders(this.options.descriptor.headers?.() ?? {})
      const response = await this.fetchImpl(sessionUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ sdp }),
        signal: this.abort.signal,
      })
      if (!response.ok) {
        const responseBody = await response.json().catch(() => null) as { error?: unknown } | null
        throw new Error(typeof responseBody?.error === 'string'
          ? responseBody.error
          : `Live session creation failed (${response.status}).`)
      }
      const body = await response.json() as { session?: { id?: unknown }; transport?: { type?: unknown; sdp?: unknown } }
      const liveSessionId = validId(body.session?.id)
      if (!liveSessionId || body.transport?.type !== 'webrtc' || typeof body.transport.sdp !== 'string') {
        throw new Error('Live session endpoint returned an invalid response.')
      }
      this.update({ liveSessionId })
      call(() => this.options.onLiveSessionId?.(liveSessionId))
      await peer.setRemoteDescription({ type: 'answer', sdp: body.transport.sdp })
      await timeout(started.promise, START_TIMEOUT_MS)
      if (generation !== this.generation) return this.state
      this.update({ status: 'connected', mode: 'listening' })
      call(() => this.options.onConnect?.(liveSessionId))
      if (context.startMuted) this.setMuted(true)
      if (context.context) this.sendContextualUpdate(context.context, 'initial-page-state')
      return this.state
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      if (generation !== this.generation) return this.state
      this.cleanup()
      this.update({ status: 'error', mode: null, muted: true, error })
      this.events.emit('error', error)
      call(() => this.options.onError?.(error))
      throw error
    }
  }

  private handleServerEvent(raw: string, generation: number): void {
    if (generation !== this.generation) return
    let event: ServerEvent
    try { event = JSON.parse(raw) as ServerEvent } catch { return }
    const type = typeof event.type === 'string' ? event.type : ''
    if (type === 'session.started') {
      const sessionId = validId(event.session?.id)
      if (sessionId && sessionId !== this.liveSessionId) {
        this.update({ liveSessionId: sessionId })
        call(() => this.options.onLiveSessionId?.(sessionId))
      }
      this.sessionStarted?.()
      return
    }
    if (type === 'session.closed') {
      this.sessionClosed?.()
      return
    }
    if (type === 'error') {
      const error = new Error(typeof event.error?.message === 'string' ? event.error.message : 'Live session error.')
      this.sessionStartFailed?.(error)
      this.events.emit('error', error)
      call(() => this.options.onError?.(error, event))
      return
    }
    if (type === 'session.input_audio.muted') {
      this.update({ muted: true })
      return
    }
    if (type === 'session.input_audio.unmuted') {
      this.update({ muted: false })
      return
    }
    if (type === 'session.delegation.created' && event.delegation?.target === 'client') {
      const delegationId = validId(event.delegation.id, 256)
      if (!delegationId || this.handledDelegations.has(delegationId)) return
      this.handledDelegations.add(delegationId)
      this.pendingDelegations.push({
        generation,
        receivedAt: Date.now(),
        delegation: {
          delegationId,
          transcript: '',
          ...(typeof event.offset_ms === 'number' ? { offsetMs: event.offset_ms } : {}),
        },
      })
      this.scheduleDelegation(generation)
      return
    }
    if (type === 'session.input_transcript.delta' || type === 'session.output_transcript.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : ''
      if (!delta) return
      this.appendTranscript(type === 'session.input_transcript.delta' ? 'user' : 'assistant', delta, event)
      return
    }
  }

  private appendTranscript(role: 'user' | 'assistant', delta: string, event: ServerEvent): void {
    const buffer = role === 'user' ? this.inputTranscript : this.outputTranscript
    const other = role === 'user' ? this.outputTranscript : this.inputTranscript
    if (other.text) this.flushTranscript(role === 'user' ? 'assistant' : 'user')
    const startMs = typeof event.start_ms === 'number' ? event.start_ms : undefined
    const endMs = typeof event.end_ms === 'number' ? event.end_ms : undefined
    if (buffer.text && startMs !== undefined && buffer.endMs !== undefined && startMs - buffer.endMs > TRANSCRIPT_IDLE_MS) {
      this.flushTranscript(role)
    }
    buffer.text += delta
    if (!buffer.firstEventId && typeof event.event_id === 'string') buffer.firstEventId = event.event_id
    if (buffer.startMs === undefined && startMs !== undefined) buffer.startMs = startMs
    if (endMs !== undefined) buffer.endMs = endMs
    if (role === 'user') {
      this.lastInputTranscriptAt = Date.now()
      if (endMs !== undefined) this.inputTranscriptEndMs = endMs
    }
    if (buffer.timer) clearTimeout(buffer.timer)
    buffer.timer = setTimeout(() => this.flushTranscript(role), TRANSCRIPT_IDLE_MS)
    if (role === 'user' && this.pendingDelegations.length > 0) {
      this.scheduleDelegation(this.pendingDelegations[0]!.generation)
    }
    if (role === 'user') this.inputActive = true
    else this.outputActive = true
    this.updateMode()
    const transcriptDelta: LiveTranscriptDelta = {
      delta,
      source: role === 'user' ? 'user' : 'ai',
      role: role === 'user' ? 'user' : 'agent',
      ...(startMs !== undefined ? { startMs } : {}),
      ...(endMs !== undefined ? { endMs } : {}),
    }
    this.events.emit('message_delta', transcriptDelta)
  }

  private flushTranscript(role: 'user' | 'assistant'): void {
    const buffer = role === 'user' ? this.inputTranscript : this.outputTranscript
    if (buffer.timer) clearTimeout(buffer.timer)
    buffer.timer = null
    const text = buffer.text.trim()
    if (role === 'user') this.inputActive = false
    else this.outputActive = false
    this.updateMode()
    if (text) {
      if (role === 'user') this.inputTranscriptSegments.push(text)
      const message: LiveMessage = {
        message: text,
        source: role === 'user' ? 'user' : 'ai',
        role: role === 'user' ? 'user' : 'agent',
        ...(buffer.firstEventId ? { eventId: buffer.firstEventId } : {}),
        ...(buffer.startMs !== undefined ? { startMs: buffer.startMs } : {}),
        ...(buffer.endMs !== undefined ? { endMs: buffer.endMs } : {}),
      }
      this.events.emit('message', message)
      call(() => this.options.onMessage?.(message))
    }
    buffer.text = ''
    delete buffer.firstEventId
    delete buffer.startMs
    delete buffer.endMs
  }

  private scheduleDelegation(generation: number): void {
    if (this.delegationTimer) clearTimeout(this.delegationTimer)
    this.delegationTimer = setTimeout(() => {
      this.delegationTimer = null
      this.claimPendingDelegation(generation)
    }, DELEGATION_SETTLE_MS)
  }

  private claimPendingDelegation(generation: number): void {
    if (generation !== this.generation || this.pendingDelegations.length === 0) return
    const pending = this.pendingDelegations[0]!
    if (pending.generation !== generation) {
      this.pendingDelegations.shift()
      this.claimPendingDelegation(generation)
      return
    }
    const now = Date.now()
    const age = now - pending.receivedAt
    const transcript = [...this.inputTranscriptSegments, this.inputTranscript.text]
      .join(' ').replace(/\s+/g, ' ').trim()
    if (!transcript) {
      if (age < DELEGATION_TRANSCRIPT_TIMEOUT_MS) {
        this.scheduleDelegation(generation)
      } else {
        this.pendingDelegations.shift()
        const error = new Error('Live delegation arrived without an input transcript.')
        this.events.emit('error', error)
        call(() => this.options.onError?.(error, pending.delegation))
      }
      return
    }
    const offsetCovered = pending.delegation.offsetMs !== undefined &&
      this.inputTranscriptEndMs !== undefined &&
      this.inputTranscriptEndMs >= pending.delegation.offsetMs
    const transcriptSettled = this.lastInputTranscriptAt > 0 &&
      now - this.lastInputTranscriptAt >= TRANSCRIPT_IDLE_MS
    if (!offsetCovered && !transcriptSettled && age < DELEGATION_TRANSCRIPT_TIMEOUT_MS) {
      this.scheduleDelegation(generation)
      return
    }
    this.flushTranscript('user')
    this.pendingDelegations.shift()
    this.inputTranscriptSegments.length = 0
    this.lastInputTranscriptAt = 0
    this.inputTranscriptEndMs = undefined
    void this.runClientDelegation({ ...pending.delegation, transcript }, generation)
    if (this.pendingDelegations.length > 0) this.scheduleDelegation(generation)
  }

  private async runClientDelegation(
    delegation: LiveClientDelegation,
    generation: number,
  ): Promise<void> {
    try {
      if (!this.options.onClientDelegation) throw new Error('Live client delegation is not configured.')
      const result = await this.options.onClientDelegation(delegation)
      if (generation !== this.generation || this.stateValue.status !== 'connected') return
      const messageText = bounded(result.message, 'backend message', 64 * 1024)
      const message: LiveBackendMessage = {
        message: messageText,
        delegationId: delegation.delegationId,
      }
      this.events.emit('backend_message', message)
      call(() => this.options.onBackendMessage?.(message))
      this.sendBackendResult(result.speech ?? messageText, delegation.delegationId)
    } catch (cause) {
      if (generation !== this.generation || this.stateValue.status !== 'connected') return
      const error = cause instanceof Error ? cause : new Error(String(cause))
      this.events.emit('error', error)
      call(() => this.options.onError?.(error, delegation))
      if (this.stateValue.status === 'connected') {
        this.sendBackendResult('I could not complete that request. Please try again.', delegation.delegationId)
      }
    }
  }

  private flushTranscripts(): void {
    this.flushTranscript('user')
    this.flushTranscript('assistant')
  }

  private send(value: Record<string, unknown>): void {
    if (!this.channel || this.channel.readyState !== 'open' || this.stateValue.status !== 'connected') {
      throw new Error('Start the live session first.')
    }
    this.channel.send(JSON.stringify(value))
  }

  private updateMode(): void {
    const mode: LiveMode = this.inputActive && this.outputActive ? 'overlap' : this.outputActive ? 'speaking' : 'listening'
    if (this.stateValue.status === 'connected' && mode !== this.stateValue.mode) {
      this.update({ mode })
      call(() => this.options.onModeChange?.(mode, this.state))
    }
  }

  private update(patch: Partial<ConvincedLiveState>): void {
    const previous = this.stateValue
    this.stateValue = { ...previous, ...patch }
    if (
      previous.status === this.stateValue.status
      && previous.mode === this.stateValue.mode
      && previous.muted === this.stateValue.muted
      && previous.liveSessionId === this.stateValue.liveSessionId
      && previous.error === this.stateValue.error
    ) return
    this.events.emit('state', this.state)
    call(() => this.options.onStatusChange?.(this.state))
  }

  private cleanup(): void {
    this.sessionStarted = null
    this.sessionStartFailed = null
    this.sessionClosed = null
    for (const buffer of [this.inputTranscript, this.outputTranscript]) {
      if (buffer.timer) clearTimeout(buffer.timer)
      buffer.timer = null
    }
    if (this.delegationTimer) clearTimeout(this.delegationTimer)
    this.delegationTimer = null
    this.pendingDelegations.length = 0
    this.lastInputTranscriptAt = 0
    this.inputTranscriptEndMs = undefined
    this.inputTranscriptSegments.length = 0
    const channel = this.channel
    const peer = this.peer
    const media = this.media
    const output = this.output
    this.channel = null; this.peer = null; this.media = null; this.output = null
    if (channel) { channel.onmessage = null; channel.onclose = null; channel.onerror = null; channel.close() }
    if (peer) { peer.ontrack = null; peer.close() }
    if (media) stop(media)
    if (output) { output.pause(); output.srcObject = null; output.remove() }
    this.inputActive = false
    this.outputActive = false
  }
}

function validateDescriptor(descriptor: LiveSessionDescriptor): void {
  if (!descriptor || (typeof descriptor.sessionUrl !== 'string' && typeof descriptor.sessionUrl !== 'function')) {
    throw new Error('live sessionUrl is required.')
  }
  if (typeof descriptor.sessionUrl === 'string') validateSessionUrl(descriptor.sessionUrl)
}

function validateSessionUrl(value: string): void {
  if (!value.trim()) throw new Error('live sessionUrl is required.')
  const url = new URL(value, typeof location === 'undefined' ? 'https://localhost' : location.href)
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !local) throw new Error('live sessionUrl must use HTTPS.')
}

function safeHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (/^(authorization|proxy-authorization|x-api-key|openai-api-key)$/i.test(name)) {
      throw new Error(`Browser live headers cannot include ${name}.`)
    }
    result[name] = value
  }
  return result
}

function bounded(value: string, name: string, maxBytes: number): string {
  const text = value.trim()
  if (!text) throw new Error(`${name} must not be empty.`)
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error(`${name} is too large.`)
  return text
}

function liveCommentary(value: string): string {
  const faithful = stripMarkdownLinks(stripMediaDirectives(value))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!faithful) throw new Error('backend speech result must not be empty.')
  return boundedWithMiddleOmission(faithful, MAX_LIVE_CONTEXT_BYTES)
}

function stripMarkdownLinks(value: string): string {
  let result = ''
  let cursor = 0
  while (cursor < value.length) {
    const opening = value.indexOf('[', cursor)
    if (opening < 0) return result + value.slice(cursor)
    const closingText = value.indexOf(']', opening + 1)
    if (closingText < 0) return result + value.slice(cursor)
    if (value[closingText + 1] !== '(') {
      result += value.slice(cursor, closingText + 1)
      cursor = closingText + 1
      continue
    }
    const closingUrl = value.indexOf(')', closingText + 2)
    if (closingUrl < 0) return result + value.slice(cursor)
    const image = opening > 0 && value[opening - 1] === '!'
    result += value.slice(cursor, image ? opening - 1 : opening)
    if (!image) result += value.slice(opening + 1, closingText)
    cursor = closingUrl + 1
  }
  return result
}

function stripMediaDirectives(value: string): string {
  let result = ''
  let cursor = 0
  while (cursor < value.length) {
    const opening = value.indexOf('[', cursor)
    if (opening < 0) return result + value.slice(cursor)
    result += value.slice(cursor, opening)
    const prefix = value.slice(opening + 1, opening + 7).toUpperCase()
    const isSlide = prefix === 'SLIDE:'
    const isVideo = prefix === 'VIDEO:'
    if (!isSlide && !isVideo) {
      result += '['
      cursor = opening + 1
      continue
    }
    const closing = value.indexOf(']', opening + 7)
    if (closing < 0) return result + value.slice(opening)
    if (closing === opening + 7) {
      result += '['
      cursor = opening + 1
      continue
    }
    cursor = closing + 1
  }
  return result
}

function boundedWithMiddleOmission(value: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  if (encoder.encode(value).byteLength <= maxBytes) return value
  const marker = '\n\n[Middle omitted for voice context]\n\n'
  const markerBytes = encoder.encode(marker).byteLength
  const available = Math.max(2, maxBytes - markerBytes)
  const headBudget = Math.floor(available * 0.7)
  const tailBudget = available - headBudget
  return `${utf8Prefix(value, headBudget).trimEnd()}${marker}${utf8Suffix(value, tailBudget).trimStart()}`
}

function utf8Prefix(value: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  let output = ''
  for (const character of value) {
    if (encoder.encode(output + character).byteLength > maxBytes) break
    output += character
  }
  return output
}

function utf8Suffix(value: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  let output = ''
  const characters = Array.from(value)
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const candidate = `${characters[index]}${output}`
    if (encoder.encode(candidate).byteLength > maxBytes) break
    output = candidate
  }
  return output
}

function validId(value: unknown, max = 256): string | null {
  return typeof value === 'string' && new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`).test(value) ? value : null
}

function id(prefix: string): string {
  const random = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '')
    : Math.random().toString(36).slice(2)
  return `${prefix}_${random}`.slice(0, 128)
}

function stop(media: MediaStream): void { for (const track of media.getTracks()) track.stop() }
function call(callback: () => void): void { try { callback() } catch { /* consumer callback */ } }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

async function timeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Live session did not connect in time.')), ms)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

async function gatherIce(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return
  await new Promise<void>((resolve, reject) => {
    const changed = () => {
      if (peer.iceGatheringState !== 'complete') return
      clearTimeout(timer)
      peer.removeEventListener('icegatheringstatechange', changed)
      resolve()
    }
    const timer = setTimeout(() => {
      peer.removeEventListener('icegatheringstatechange', changed)
      reject(new Error('WebRTC ICE gathering timed out.'))
    }, ICE_TIMEOUT_MS)
    peer.addEventListener('icegatheringstatechange', changed)
  })
}

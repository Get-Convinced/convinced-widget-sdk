import { afterEach, describe, expect, test } from 'bun:test'
import {
  ConvincedClient, ConvincedLiveController, type JsonObject,
} from '../src'

class FakeChannel {
  readyState = 'open'
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  sent: JsonObject[] = []
  closed = false
  send(data: string) {
    const event = JSON.parse(data) as JsonObject
    this.sent.push(event)
    if (event.type === 'session.close') queueMicrotask(() => this.emit({ type: 'session.closed' }))
  }
  close() { this.closed = true; this.readyState = 'closed' }
  emit(event: JsonObject) { this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>) }
}

class FakePeer {
  iceGatheringState = 'complete'
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  ontrack: ((event: RTCTrackEvent) => void) | null = null
  channel = new FakeChannel()
  closed = false
  createDataChannel() { return this.channel as unknown as RTCDataChannel }
  addTrack() {}
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: 'browser-offer' } }
  async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value }
  async setRemoteDescription(value: RTCSessionDescriptionInit) { this.remoteDescription = value }
  addEventListener() {}
  removeEventListener() {}
  close() { this.closed = true }
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const originalPeer = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection')
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
let peer: FakePeer
let track: { enabled: boolean; stopped: boolean; stop(): void }

afterEach(() => {
  restore('navigator', originalNavigator)
  restore('RTCPeerConnection', originalPeer)
  restore('document', originalDocument)
})

describe('GPT Live WebRTC controller', () => {
  test('ending during microphone permission prevents a late Live connection', async () => {
    installBrowser()
    let grantMicrophone!: (media: MediaStream) => void
    const microphone = new Promise<MediaStream>((resolve) => { grantMicrophone = resolve })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { mediaDevices: { getUserMedia: () => microphone } },
    })
    let liveRequests = 0
    const controller = new ConvincedLiveController({
      descriptor: { sessionUrl: 'https://app.example/live' },
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        liveRequests += 1
        return Response.json({})
      }) as typeof fetch,
    })

    const pendingStart = controller.start()
    expect(controller.state.status).toBe('connecting')
    await controller.end()
    expect(controller.state.status).toBe('disconnected')
    grantMicrophone({ getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream)
    await pendingStart

    expect(track.stopped).toBe(true)
    expect(controller.state.status).toBe('disconnected')
    expect(liveRequests).toBe(0)
  })

  test('uses the official protocol, mute, and graceful close', async () => {
    installBrowser()
    let requestBody: JsonObject = {}
    const controller = new ConvincedLiveController({
      descriptor: { sessionUrl: 'https://app.example/live' },
      fetch: (async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as JsonObject
        queueMicrotask(() => peer.channel.emit({ type: 'session.started', session: { id: 'live_1' } }))
        return Response.json({ session: { id: 'live_1' }, transport: { type: 'webrtc', sdp: 'server-answer' } })
      }) as typeof fetch,
    })

    const state = await controller.start({ context: 'Page: pricing' })
    expect(state).toMatchObject({ status: 'connected', liveSessionId: 'live_1', muted: false })
    expect(Object.keys(requestBody).sort()).toEqual(['sdp'])
    expect(requestBody.sdp).toBe('browser-offer')
    expect(peer.remoteDescription).toEqual({ type: 'answer', sdp: 'server-answer' })
    expect(peer.channel.sent).toContainEqual(expect.objectContaining({
      type: 'session.thinking.append', delegation_id: null,
    }))
    controller.sendBackendResult(`Margin changed by -5%.\n\n${'Detail. '.repeat(2_000)}\nFinal caveat: -2 units.`)
    const commentary = [...peer.channel.sent].reverse()
      .find((event: JsonObject) => event.type === 'session.commentary.append')
    expect(commentary?.content).toContain('Margin changed by -5%.')
    expect(commentary?.content).toContain('[Middle omitted for voice context]')
    expect(commentary?.content).toContain('Final caveat: -2 units.')
    expect(new TextEncoder().encode(String(commentary?.content)).byteLength).toBeLessThanOrEqual(8 * 1024)

    controller.setMuted(true)
    expect(track.enabled).toBe(false)
    expect(peer.channel.sent).toContainEqual(expect.objectContaining({ type: 'session.input_audio.mute' }))
    peer.channel.emit({ type: 'session.input_audio.muted' })
    expect(controller.state.muted).toBe(true)
    await controller.end()
    expect(peer.channel.sent).toContainEqual(expect.objectContaining({ type: 'session.close' }))
    expect(track.stopped).toBe(true)
    expect(peer.closed).toBe(true)
    expect(controller.state.status).toBe('disconnected')
  })

  test('one Luna chat continues across text, voice, interleaved text, and voice off', async () => {
    installBrowser()
    let endBody: JsonObject = {}
    let liveBody: JsonObject = {}
    let liveCapability = ''
    let liveWidgetToken = ''
    let sessionBody: JsonObject = {}
    let sdkVersion = ''
    let liveCreates = 0
    let chatCalls = 0
    const client = new ConvincedClient({
      orgSlug: 'demo',
      agentId: 'deployment_live',
      apiBase: 'https://app.example',
      widgetToken: 'widget_token',
      fetch: (async (input, init = {}) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/live')) {
          liveCreates += 1
          liveBody = JSON.parse(String(init.body)) as JsonObject
          liveCapability = new Headers(init.headers).get('x-widget-session-capability') ?? ''
          liveWidgetToken = new Headers(init.headers).get('x-widget-token') ?? ''
          queueMicrotask(() => peer.channel.emit({ type: 'session.started', session: { id: 'live_owned' } }))
          return Response.json({ session: { id: 'live_owned' }, transport: { type: 'webrtc', sdp: 'answer' } })
        }
        if (url.pathname.endsWith('/session/end')) {
          endBody = JSON.parse(String(init.body)) as JsonObject
          return Response.json({ ok: true })
        }
        if (url.pathname.endsWith('/chat')) {
          chatCalls += 1
          const body = JSON.parse(String(init.body)) as JsonObject
          const message = String(body.message)
          const answer = message === 'Show the ROI slide'
            ? '### ROI\n[Read the proof](https://example.com/roi)\n\n[SLIDE:roi.svg]'
            : message === 'Typed follow-up'
              ? '**Typed while voice stays on.**'
              : 'Continued after voice was disabled.'
          return sse(answer)
        }
        if (url.pathname.endsWith('/session')) {
          sessionBody = JSON.parse(String(init.body)) as JsonObject
          sdkVersion = new Headers(init.headers).get('x-convinced-sdk-version') ?? ''
          return Response.json({
            sessionId: 'session_owned',
            sessionCapability: 'capability_owned',
            config: { orgName: 'Demo', orgSlug: 'demo', voiceEnabled: true },
          })
        }
        throw new Error(`Unexpected URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession()
    const live = client.createLiveController()
    expect(() => client.createLiveController()).toThrow('already owns a Live controller')
    await live.start()
    peer.channel.emit({
      type: 'session.input_transcript.delta', event_id: 'input_1', delta: 'Show the ', start_ms: 0, end_ms: 100,
    })
    peer.channel.emit({
      type: 'session.delegation.created',
      offset_ms: 1200,
      delegation: { id: 'delegation_voice_1', type: 'delegation', target: 'client' },
    })
    await Bun.sleep(300)
    peer.channel.emit({
      type: 'session.input_transcript.delta', event_id: 'input_2', delta: 'ROI slide', start_ms: 1_501, end_ms: 1_700,
    })
    await waitFor(() => client.state.messages.some(message => message.text.startsWith('### ROI')))
    expect(client.state.messages[0]).toMatchObject({ role: 'user', text: 'Show the ROI slide' })
    expect(peer.channel.sent).toContainEqual(expect.objectContaining({
      type: 'session.commentary.append',
      delegation_id: 'delegation_voice_1',
      content: expect.not.stringContaining('[SLIDE:'),
    }))

    await client.sendMessage('Typed follow-up')
    expect(live.state.status).toBe('connected')
    expect(peer.channel.sent).toContainEqual(expect.objectContaining({
      type: 'session.commentary.append',
      delegation_id: null,
      content: expect.stringContaining('Typed while voice stays on.'),
    }))
    await live.end()
    await client.sendMessage('Text after voice')
    await client.endSession()

    expect(liveCapability).toBe('capability_owned')
    expect(liveWidgetToken).toBe('widget_token')
    expect(sessionBody.agentId).toBe('deployment_live')
    expect(sdkVersion).toBe('0.1.5')
    expect(Object.keys(liveBody).sort()).toEqual(['sdp'])
    expect(liveCreates).toBe(1)
    expect(chatCalls).toBe(3)
    expect(endBody).toMatchObject({
      sessionId: 'session_owned',
      clientMessages: [
        expect.objectContaining({ role: 'user', content: 'Show the ROI slide' }),
        expect.objectContaining({ role: 'assistant', content: expect.stringContaining('### ROI') }),
        expect.objectContaining({ role: 'user', content: 'Typed follow-up' }),
        expect.objectContaining({ role: 'assistant', content: '**Typed while voice stays on.**' }),
        expect.objectContaining({ role: 'user', content: 'Text after voice' }),
        expect.objectContaining({ role: 'assistant', content: 'Continued after voice was disabled.' }),
      ],
    })
    expect(endBody).not.toHaveProperty('liveSessionIds')
  })

  test('does not speak a delegated answer after the Live generation ends', async () => {
    installBrowser()
    let delegated = false
    let finish!: (value: { message: string }) => void
    const answer = new Promise<{ message: string }>((resolve) => { finish = resolve })
    const controller = new ConvincedLiveController({
      descriptor: { sessionUrl: 'https://app.example/live' },
      fetch: (async (_input, _init) => {
        queueMicrotask(() => peer.channel.emit({ type: 'session.started', session: { id: 'live_1' } }))
        return Response.json({ session: { id: 'live_1' }, transport: { type: 'webrtc', sdp: 'server-answer' } })
      }) as typeof fetch,
      onClientDelegation: async () => {
        delegated = true
        return answer
      },
    })
    await controller.start()
    peer.channel.emit({ type: 'session.input_transcript.delta', delta: 'Explain the proof', end_ms: 1000 })
    peer.channel.emit({
      type: 'session.delegation.created',
      offset_ms: 1000,
      delegation: { id: 'delegation_late', target: 'client' },
    })
    await waitFor(() => delegated)
    await controller.end()
    finish({ message: 'This answer arrived too late.' })
    await Bun.sleep(5)

    expect(peer.channel.sent).not.toContainEqual(expect.objectContaining({
      type: 'session.commentary.append', delegation_id: 'delegation_late',
    }))
  })

  test('passes Live-native clarification to Luna with the next delegated request', async () => {
    installBrowser()
    const chatBodies: JsonObject[] = []
    const client = new ConvincedClient({
      orgSlug: 'demo',
      fetch: (async (input, init = {}) => {
        const path = new URL(String(input)).pathname
        if (path.endsWith('/session')) return Response.json({
          sessionId: 'session_1', sessionCapability: 'cap_1',
          config: { orgName: 'Demo', orgSlug: 'demo', voiceEnabled: true },
        })
        if (path.endsWith('/live')) {
          queueMicrotask(() => peer.channel.emit({ type: 'session.started', session: { id: 'live_1' } }))
          return Response.json({ session: { id: 'live_1' }, transport: { type: 'webrtc', sdp: 'answer' } })
        }
        if (path.endsWith('/chat')) {
          chatBodies.push(JSON.parse(String(init.body)) as JsonObject)
          return sse(chatBodies.length === 1 ? 'Earlier typed answer.' : 'I can show that workflow.')
        }
        throw new Error(`Unexpected URL: ${input}`)
      }) as typeof fetch,
    })
    await client.createSession()
    const deliveredMessages: string[] = []
    client.on('message', message => deliveredMessages.push(message.text))
    await client.sendMessage('Earlier typed question.')
    const live = client.createLiveController()
    await live.start()
    peer.channel.emit({ type: 'session.input_transcript.delta', delta: 'Help me understand this.' })
    peer.channel.emit({ type: 'session.output_transcript.delta', delta: 'Which workflow should we look at?' })
    peer.channel.emit({ type: 'session.input_transcript.delta', delta: 'Dispatch planning.' })
    peer.channel.emit({ type: 'session.delegation.created', delegation: { id: 'clarification_1', target: 'client' } })

    await waitFor(() => chatBodies.length === 2)
    expect(chatBodies[1]?.history).toEqual([
      { role: 'user', content: 'Earlier typed question.' },
      { role: 'assistant', content: 'Earlier typed answer.' },
      { role: 'user', content: 'Help me understand this.' },
      { role: 'assistant', content: 'Which workflow should we look at?' },
    ])
    expect(deliveredMessages).not.toContain('Help me understand this.')
    expect(deliveredMessages).not.toContain('Which workflow should we look at?')
    expect(chatBodies[1]?.message).toBe('Dispatch planning.')
    await live.end()
  })

  test('shares a Live-native exchange with typed chat and the session transcript', async () => {
    installBrowser()
    const chatBodies: JsonObject[] = []
    let endBody: JsonObject = {}
    const client = new ConvincedClient({
      orgSlug: 'demo',
      fetch: (async (input, init = {}) => {
        const path = new URL(String(input)).pathname
        if (path.endsWith('/session')) return Response.json({
          sessionId: 'session_1', sessionCapability: 'cap_1',
          config: { orgName: 'Demo', orgSlug: 'demo', voiceEnabled: true },
        })
        if (path.endsWith('/live')) {
          queueMicrotask(() => peer.channel.emit({ type: 'session.started', session: { id: 'live_1' } }))
          return Response.json({ session: { id: 'live_1' }, transport: { type: 'webrtc', sdp: 'answer' } })
        }
        if (path.endsWith('/chat')) {
          chatBodies.push(JSON.parse(String(init.body)) as JsonObject)
          return sse(`Answer ${chatBodies.length}.`)
        }
        if (path.endsWith('/session/end')) {
          endBody = JSON.parse(String(init.body)) as JsonObject
          return Response.json({ ok: true })
        }
        throw new Error(`Unexpected URL: ${input}`)
      }) as typeof fetch,
    })
    await client.createSession()
    let sawNativeState = false
    client.on('state', state => {
      sawNativeState ||= state.messages.some(message => message.text === 'Which workflow should we look at?')
    })
    await client.sendMessage('Earlier typed question.')
    const live = client.createLiveController()
    await live.start()
    peer.channel.emit({ type: 'session.input_transcript.delta', delta: 'Help me understand this.' })
    peer.channel.emit({ type: 'session.output_transcript.delta', delta: 'Which workflow should we look at?' })
    await waitFor(() => sawNativeState)
    await client.sendMessage('Dispatch planning, please.')
    expect(chatBodies[1]?.history).toEqual([
      { role: 'user', content: 'Earlier typed question.' },
      { role: 'assistant', content: 'Answer 1.' },
      { role: 'user', content: 'Help me understand this.' },
      { role: 'assistant', content: 'Which workflow should we look at?' },
    ])
    expect(client.state.messages.map(message => ({ role: message.role, text: message.text }))).toEqual([
      { role: 'user', text: 'Earlier typed question.' },
      { role: 'assistant', text: 'Answer 1.' },
      { role: 'user', text: 'Help me understand this.' },
      { role: 'assistant', text: 'Which workflow should we look at?' },
      { role: 'user', text: 'Dispatch planning, please.' },
      { role: 'assistant', text: 'Answer 2.' },
    ])
    peer.channel.emit({ type: 'session.input_transcript.delta', delta: 'What about timing?' })
    peer.channel.emit({ type: 'session.delegation.created', delegation: { id: 'timing', target: 'client' } })
    await waitFor(() => chatBodies.length === 3)
    expect(chatBodies[2]?.history).toEqual([
      { role: 'user', content: 'Earlier typed question.' },
      { role: 'assistant', content: 'Answer 1.' },
      { role: 'user', content: 'Help me understand this.' },
      { role: 'assistant', content: 'Which workflow should we look at?' },
      { role: 'user', content: 'Dispatch planning, please.' },
      { role: 'assistant', content: 'Answer 2.' },
    ])
    expect(chatBodies[2]?.message).toBe('What about timing?')
    await waitFor(() => client.state.messages.some(message => message.text === 'Answer 3.'))
    await client.endSession()
    expect(endBody.clientMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'Help me understand this.' }),
      expect.objectContaining({ role: 'assistant', content: 'Which workflow should we look at?' }),
    ]))
  })

  test('a newer delegation suppresses an older answer', async () => {
    installBrowser()
    const finish = new Map<string, (value: { message: string }) => void>()
    const controller = new ConvincedLiveController({
      descriptor: { sessionUrl: 'https://app.example/live' },
      fetch: (async () => {
        queueMicrotask(() => peer.channel.emit({ type: 'session.started', session: { id: 'live_1' } }))
        return Response.json({ session: { id: 'live_1' }, transport: { type: 'webrtc', sdp: 'answer' } })
      }) as unknown as typeof fetch,
      onClientDelegation: ({ delegationId }) => new Promise(resolve => { finish.set(delegationId, resolve) }),
    })
    await controller.start()
    peer.channel.emit({ type: 'session.input_transcript.delta', delta: 'Show the old slide.' })
    peer.channel.emit({ type: 'session.delegation.created', delegation: { id: 'old', target: 'client' } })
    await waitFor(() => finish.has('old'))
    peer.channel.emit({ type: 'session.input_transcript.delta', delta: 'Actually, show the new slide.' })
    peer.channel.emit({ type: 'session.delegation.created', delegation: { id: 'new', target: 'client' } })
    finish.get('old')!({ message: 'Old slide is visible.' })
    await waitFor(() => finish.has('new'))
    finish.get('new')!({ message: 'New slide is visible.' })
    await waitFor(() => peer.channel.sent.some(event => event.type === 'session.commentary.append' && event.delegation_id === 'new'))
    expect(peer.channel.sent).not.toContainEqual(expect.objectContaining({
      type: 'session.commentary.append', delegation_id: 'old',
    }))
    await controller.end()
  })

  test('reports browser audio playback failure to the host', async () => {
    installBrowser(async () => { throw new Error('Audio playback was blocked.') })
    const errors: Error[] = []
    const controller = new ConvincedLiveController({
      descriptor: { sessionUrl: 'https://app.example/live' },
      fetch: (async () => {
        queueMicrotask(() => peer.channel.emit({ type: 'session.started', session: { id: 'live_1' } }))
        return Response.json({ session: { id: 'live_1' }, transport: { type: 'webrtc', sdp: 'answer' } })
      }) as unknown as typeof fetch,
      onError: error => errors.push(error),
    })
    await controller.start()
    peer.ontrack?.({ streams: [{}] } as unknown as RTCTrackEvent)
    await waitFor(() => errors.length > 0)
    expect(errors[0]?.message).toBe('Audio playback was blocked.')
    await controller.end()
  })

  test('does not record overlapping Luna speech as a native exchange', async () => {
    installBrowser()
    const nativeExchanges: Array<{ user: string; assistant: string }> = []
    const controller = new ConvincedLiveController({
      descriptor: { sessionUrl: 'https://app.example/live' },
      fetch: (async () => {
        queueMicrotask(() => peer.channel.emit({ type: 'session.started', session: { id: 'live_1' } }))
        return Response.json({ session: { id: 'live_1' }, transport: { type: 'webrtc', sdp: 'answer' } })
      }) as unknown as typeof fetch,
      onNativeExchange: (user, assistant) => nativeExchanges.push({ user, assistant }),
      onClientDelegation: () => ({ message: 'Backend answer.' }),
    })
    await controller.start()
    peer.channel.emit({ type: 'session.input_transcript.delta', delta: 'Show the result.' })
    peer.channel.emit({ type: 'session.delegation.created', delegation: { id: 'first', target: 'client' } })
    await waitFor(() => peer.channel.sent.some(event => event.type === 'session.commentary.append' && event.delegation_id === 'first'))
    peer.channel.emit({ type: 'session.output_transcript.delta', delta: 'Here is', start_ms: 1, end_ms: 100 })
    peer.channel.emit({ type: 'session.input_transcript.delta', delta: 'Actually,', start_ms: 200, end_ms: 300 })
    peer.channel.emit({ type: 'session.output_transcript.delta', delta: ' the result.', start_ms: 1_500, end_ms: 1_600 })
    peer.channel.emit({ type: 'session.input_transcript.delta', delta: ' the new one.', start_ms: 1_700, end_ms: 1_900 })
    peer.channel.emit({ type: 'session.delegation.created', delegation: { id: 'follow_up', target: 'client' } })
    await waitFor(() => peer.channel.sent.some(event => event.type === 'session.commentary.append' && event.delegation_id === 'follow_up'))
    expect(nativeExchanges).toEqual([])
    await controller.end()
  })
})

function sse(text: string): Response {
  return new Response(`data: ${JSON.stringify({ delta: text })}\n\ndata: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function installBrowser(play: () => Promise<void> = async () => undefined): void {
  track = { enabled: true, stopped: false, stop() { this.stopped = true } }
  peer = new FakePeer()
  const media = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, value: { mediaDevices: { getUserMedia: async () => media } },
  })
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    configurable: true, value: class { constructor() { return peer } },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({
      autoplay: false, srcObject: null, volume: 1,
      play, pause: () => undefined, remove: () => undefined,
    }) },
  })
}

function restore(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  else Reflect.deleteProperty(globalThis, name)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(2)
  }
  throw new Error('Timed out waiting for condition.')
}

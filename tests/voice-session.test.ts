import { describe, expect, test } from 'bun:test'
import { ConvincedClient, type ElevenLabsStartSessionOptions, type JsonObject } from '../src'

function fixture() {
  const calls: { path: string; body: JsonObject }[] = []
  const starts: ElevenLabsStartSessionOptions[] = []
  let failEnd = false
  let sessionNumber = 0
  let sessionGate: Promise<void> | null = null
  let releaseSession: (() => void) | undefined
  const client = new ConvincedClient({
    orgSlug: 'demo', apiBase: 'https://mock.example',
    fetch: (async (input, init = {}) => {
      const path = new URL(String(input)).pathname
      const body = init.body ? JSON.parse(String(init.body)) : {}
      calls.push({ path, body })
      if (path.endsWith('/session') && sessionGate) { await sessionGate; sessionGate = null }
      if (path.endsWith('/session')) return Response.json({ sessionId: `session_${++sessionNumber}`, config: { orgSlug: 'demo', orgName: 'Demo', elevenLabsAgentId: 'agent_demo', slidesEnabled: false } })
      if (path.endsWith('/chat')) return new Response('data: {"delta":"Text answer"}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      if (path.endsWith('/session/end')) return failEnd ? Response.json({error:'retry'}, {status:503}) : Response.json({ok:true})
      throw new Error(`Unexpected request: ${path}`)
    }) as typeof fetch,
  })
  const voice = client.createVoiceController({
    conversationFactory: async (options) => {
      starts.push(options)
      const id = `conv_${starts.length}`
      options.onConnect?.({conversationId:id})
      return { getId: () => id, setMicMuted() {}, sendContextualUpdate() {}, sendUserMessage() {}, sendUserActivity() {},
        async endSession() { options.onMessage?.({source:'ai',role:'agent',message:'Final voice answer',event_id:99}) },
      }
    },
  })
  const emit = (role: 'user' | 'agent', text: string, event_id: number) => starts.at(-1)!.onMessage?.({source:role === 'user' ? 'user' : 'ai',role,message:text,event_id})
  return { client, voice, calls, starts, emit, holdSession: () => { sessionGate = new Promise(resolve => {releaseSession = resolve}); return () => releaseSession?.() }, fail: (value: boolean) => {failEnd=value} }
}

describe('session-owned headless voice', () => {
  test('one Convinced session captures text, voice, final turns and provider mapping without host wiring', async () => {
    const f=fixture()
    await f.client.createSession()
    await f.client.sendMessage('Text question')
    await f.voice.start({dynamicVariables:{SESSION_ID:'forged'}})
    expect(f.starts[0]?.dynamicVariables?.SESSION_ID).toBe('session_1')
    f.emit('user','Voice question',1)
    f.emit('user','Voice question',1) // duplicate provider delivery
    f.emit('agent','Voice answer',2)
    await f.client.endSession()
    const body=f.calls.find(c=>c.path.endsWith('/session/end'))!.body
    expect(body.sessionId).toBe('session_1')
    expect(body.elevenLabsConversationIds).toEqual(['conv_1'])
    expect((body.clientMessages as unknown as Array<{content:string}>).map(m=>m.content)).toEqual(['Text question','Text answer','Voice question','Voice answer','Final voice answer'])
    expect(f.voice.state.status).toBe('disconnected')
    expect(f.client.state.messages.at(-1)?.role).toBe('assistant')
  })
  test('captures typed voice messages even when the provider does not echo them', async () => {
    const f = fixture()
    await f.client.createSession()
    await f.voice.start()
    f.voice.sendUserMessage('Show me the leadership section on this page.')
    f.emit('agent', 'Opening Leadership.', 1)
    f.voice.sendUserMessage('Yes')
    f.voice.sendUserMessage('Yes')
    await f.client.endSession()
    const body = f.calls.find(c => c.path.endsWith('/session/end'))!.body
    expect((body.clientMessages as unknown as Array<{content:string}>).map(m => m.content)).toEqual([
      'Show me the leadership section on this page.', 'Opening Leadership.', 'Yes', 'Yes', 'Final voice answer',
    ])
    expect(() => f.voice.sendUserMessage('After close')).toThrow()
    expect(f.client.state.messages.some(m => m.text === 'After close')).toBe(false)
  })
  test('reconnects retain repeated legitimate turns, isolate event IDs, and retry the same transcript after a failed save', async () => {
    const f=fixture(); await f.client.createSession(); await f.voice.start()
    f.emit('user','Yes',1); f.emit('user','Yes',2)
    await f.voice.end(); await f.voice.start(); f.emit('user','Yes',1)
    f.fail(true); await expect(f.client.endSession()).rejects.toThrow()
    f.fail(false); await f.client.endSession(); await f.client.endSession()
    const ends=f.calls.filter(c=>c.path.endsWith('/session/end'))
    expect(ends).toHaveLength(2)
    expect(ends[0]?.body).toEqual(ends[1]?.body)
    expect(ends[1]?.body.elevenLabsConversationIds).toEqual(['conv_1','conv_2'])
    expect((ends[1]?.body.clientMessages as unknown as Array<{content:string}>).filter(m=>m.content==='Yes')).toHaveLength(3)
    await expect(f.voice.start()).rejects.toThrow('ended')
    await f.client.renewSession(); await f.voice.start()
    expect(f.starts.at(-1)?.dynamicVariables?.SESSION_ID).toBe('session_2')
    expect(f.client.state.messages).toEqual([])
    await f.client.endSession()
    expect(f.calls.at(-1)?.body.elevenLabsConversationIds).toEqual(['conv_3'])
  })
  test('does not allow a session switch while voice is active or a provider override of the Convinced ID', async () => {
    const f=fixture(); await f.client.createSession(); await f.voice.start()
    await expect(f.client.renewSession()).rejects.toThrow('voice')
    f.client.destroy()
    await Bun.sleep(0)
    f.emit('user','late',42)
    expect(f.client.state.status).toBe('destroyed')
    expect(f.client.state.messages.some(m=>m.text==='late')).toBe(false)
  })
  test('cannot bind voice to the old session while renewal is awaiting HTTP', async () => {
    const f=fixture(); await f.client.createSession()
    const release=f.holdSession()
    const pending=f.client.renewSession()
    await expect(f.voice.start()).rejects.toThrow('pending session')
    release(); await pending
    await f.voice.start()
    expect(f.starts.at(-1)?.dynamicVariables?.SESSION_ID).toBe('session_2')
    f.emit('user','Captured after renewal',1)
    await f.client.endSession()
    expect(f.calls.at(-1)?.body.sessionId).toBe('session_2')
    expect(f.client.state.messages[0]?.text).toBe('Captured after renewal')
  })

})

import { describe, expect, test } from 'bun:test'
import {
  ClientToolRegistry,
  ConvincedClient,
  ConvincedSdkError,
  HOST_TOOL_PROTOCOL_VERSION,
  type ClientTool,
  type JsonObject,
} from '../src'

const config = {
  orgName: 'Demo Store',
  orgSlug: 'demo',
  slidesEnabled: false,
  suggestedQuestions: [],
}

describe('ConvincedClient transport', () => {
  test('ordinary chat omits the host bridge when no tools are registered', async () => {
    const bodies: JsonObject[] = []
    const client = await sessionClient(async (_url, init) => {
      bodies.push(await requestBody(init))
      return sse([{ delta: 'Hello from Convinced.' }])
    })

    const events: string[] = []
    client.on('message', (message) => events.push(`${message.role}:${message.text}`))
    const response = await client.sendMessage('Hello')

    expect(response.text).toBe('Hello from Convinced.')
    expect(bodies[0]).not.toHaveProperty('clientTools')
    expect(bodies[0]).not.toHaveProperty('clientTurnId')
    expect(events).toEqual(['user:Hello', 'assistant:Hello from Convinced.'])
  })

  test('parses long malformed directives received over SSE within a fixed time bound', async () => {
    const malformedAssistantText = '[SLIDE:\\'.repeat(20_000)
    const client = await sessionClient(async () => sse([
      { delta: malformedAssistantText },
    ]))
    const startedAt = performance.now()

    const response = await client.sendMessage('Show the proof')

    expect(response.text).toBe(malformedAssistantText)
    expect(response.content).toEqual([{ type: 'text', text: malformedAssistantText }])
    expect(performance.now() - startedAt).toBeLessThan(1_000)
  }, 2_000)

  test('removes a typed event listener with off()', async () => {
    const client = await sessionClient(async () => sse([{ delta: 'Done.' }]))
    const messages: string[] = []
    const listener = (message: { text: string }) => messages.push(message.text)
    client.on('message', listener)
    client.off('message', listener)

    await client.sendMessage('Hello')
    expect(messages).toEqual([])
  })

  test('executes a host tool and resumes with the signed capability', async () => {
    const bodies: JsonObject[] = []
    const sessionCapabilities: string[] = []
    const registry = new ClientToolRegistry([
      tool('host_read_cart', async (arguments_) => ({ count: arguments_.expectedCount ?? null })),
    ])
    const client = await sessionClient(async (_url, init) => {
      sessionCapabilities.push(new Headers(init.headers).get('x-widget-session-capability') ?? '')
      const body = await requestBody(init)
      bodies.push(body)
      const turnId = String(body.clientTurnId)
      if (body.resumeClientTurn !== true) {
        return sse([
          toolCall(turnId, 'call_1', 'host_read_cart', { expectedCount: 2 }),
          { type: 'client_tool_pause', turnId, capability: 'signed-capability-1', expiresAt: 4_102_444_800_000 },
        ])
      }
      return sse([{ delta: 'You have two products in your cart.' }])
    }, registry)

    const response = await client.sendMessage('What is in my cart?')
    const initialTurnId = bodies[0]?.clientTurnId
    expect(typeof initialTurnId).toBe('string')
    expect(String(initialTurnId).length).toBeGreaterThanOrEqual(8)
    expect(bodies[0]?.clientTools as unknown).toEqual(registry.definitions())
    expect(bodies[1]?.clientTurnId).toBe(initialTurnId)
    expect(bodies[1]?.clientToolCapability).toBe('signed-capability-1')
    expect(bodies[1]?.resumeClientTurn).toBe(true)
    expect(bodies[1]?.clientToolResults).toEqual([
      expect.objectContaining({
        version: 1,
        callId: 'call_1',
        name: 'host_read_cart',
        args: { expectedCount: 2 },
        ok: true,
        result: { count: 2 },
      }),
    ])
    expect(sessionCapabilities).toEqual([
      'capability_session_123',
      'capability_session_123',
    ])
    expect(response.text).toContain('two products')
  })

  test('protocol-owned request fields cannot be overwritten by chat context', async () => {
    let body: JsonObject | undefined
    const fetchMock = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/session')) {
        return Response.json({ sessionId: 'session_canonical', config })
      }
      if (url.pathname.endsWith('/chat')) {
        body = await requestBody(init)
        return sse([{ delta: 'Canonical.' }])
      }
      throw new Error(`Unexpected mock URL: ${url}`)
    }) as typeof fetch
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: fetchMock,
      defaultChatContext: {
        sessionId: 'forged-default',
        message: 'forged-default',
        resumeClientTurn: true,
        clientToolCapability: 'forged-default',
      },
    })
    await client.createSession()

    await client.sendMessage('Real message', {
      history: [{ role: 'user', content: 'Real history' }],
      context: {
        sessionId: 'forged-call',
        message: 'forged-call',
        history: [],
        clientTools: [{ forged: true }],
        clientTurnId: 'forged-call',
        clientToolResults: [{ forged: true }],
      },
    })

    expect(body).toMatchObject({
      sessionId: 'session_canonical',
      message: 'Real message',
      history: [{ role: 'user', content: 'Real history' }],
    })
    expect(body).not.toHaveProperty('clientTools')
    expect(body).not.toHaveProperty('clientTurnId')
    expect(body).not.toHaveProperty('resumeClientTurn')
    expect(body).not.toHaveProperty('clientToolCapability')
    expect(body).not.toHaveProperty('clientToolResults')
  })

  test('accumulates all results across a two-round continuation chain', async () => {
    const bodies: JsonObject[] = []
    const registry = new ClientToolRegistry([
      tool('host_first_step', async () => ({ first: true })),
      tool('host_second_step', async () => ({ second: true })),
    ])
    const client = await sessionClient(async (_url, init) => {
      const body = await requestBody(init)
      bodies.push(body)
      const turnId = String(body.clientTurnId)
      if (bodies.length === 1) {
        return sse([
          toolCall(turnId, 'call_first', 'host_first_step', {}),
          { type: 'client_tool_pause', turnId, capability: 'capability-one' },
        ])
      }
      if (bodies.length === 2) {
        return sse([
          toolCall(turnId, 'call_second', 'host_second_step', {}),
          { type: 'client_tool_pause', turnId, capability: 'capability-two' },
        ])
      }
      return sse([{ delta: 'Both host actions completed.' }])
    }, registry)

    await client.sendMessage('Run both steps')
    expect((bodies[1]?.clientToolResults as unknown[]).length).toBe(1)
    expect((bodies[2]?.clientToolResults as Array<{ callId: string }>).map((result) => result.callId)).toEqual([
      'call_first',
      'call_second',
    ])
    expect(bodies[2]?.clientToolCapability).toBe('capability-two')
    expect(new Set(bodies.map((body) => body.clientTurnId)).size).toBe(1)
  })

  test('rejects a pause without a capability and removes the empty assistant placeholder', async () => {
    const registry = new ClientToolRegistry([tool('host_read_cart', async () => ({ count: 2 }))])
    const client = await sessionClient(async (_url, init) => {
      const body = await requestBody(init)
      const turnId = String(body.clientTurnId)
      return sse([
        toolCall(turnId, 'call_1', 'host_read_cart', {}),
        { type: 'client_tool_pause', turnId },
      ])
    }, registry)

    await expect(client.sendMessage('Read cart')).rejects.toMatchObject({
      code: 'missing_client_tool_capability',
    })
    expect(client.state.messages.map((message) => `${message.role}:${message.text}`)).toEqual([
      'user:Read cart',
    ])
    expect(client.state.messages.some((message) => message.role === 'assistant' && !message.text)).toBe(false)
  })

  test('rejects duplicate call ids across continuation rounds', async () => {
    let requestCount = 0
    const registry = new ClientToolRegistry([tool('host_read_cart', async () => ({ count: 2 }))])
    const client = await sessionClient(async (_url, init) => {
      requestCount += 1
      const body = await requestBody(init)
      const turnId = String(body.clientTurnId)
      return sse([
        toolCall(turnId, 'same_call', 'host_read_cart', {}),
        { type: 'client_tool_pause', turnId, capability: `capability-${requestCount}` },
      ])
    }, registry)

    try {
      await client.sendMessage('Repeat')
      throw new Error('Expected duplicate call rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(ConvincedSdkError)
      expect((error as ConvincedSdkError).code).toBe('duplicate_client_tool_call')
    }
  })

  test('stops after the canonical maximum of four continuation rounds', async () => {
    let requestCount = 0
    let executionCount = 0
    const registry = new ClientToolRegistry([
      tool('host_repeat_step', async () => {
        executionCount += 1
        return { completed: executionCount }
      }),
    ])
    const client = await sessionClient(async (_url, init) => {
      requestCount += 1
      const body = await requestBody(init)
      const turnId = String(body.clientTurnId)
      return sse([
        toolCall(turnId, `call_${requestCount}`, 'host_repeat_step', {}),
        { type: 'client_tool_pause', turnId, capability: `capability-${requestCount}` },
      ])
    }, registry)

    await expect(client.sendMessage('Keep going')).rejects.toMatchObject({
      code: 'client_tool_round_limit',
    })
    expect(requestCount).toBe(5)
    expect(executionCount).toBe(4)
  })

  test('rejects a continuation round before executing more than 16 calls', async () => {
    let requestCount = 0
    let executionCount = 0
    const registry = new ClientToolRegistry([
      tool('host_bounded_step', async () => {
        executionCount += 1
        return { executionCount }
      }),
    ])
    const client = await sessionClient(async (_url, init) => {
      requestCount += 1
      const body = await requestBody(init)
      const turnId = String(body.clientTurnId)
      return sse([
        ...Array.from({ length: 17 }, (_, index) => (
          toolCall(turnId, `call_${index + 1}`, 'host_bounded_step', {})
        )),
        { type: 'client_tool_pause', turnId, capability: 'capability-1' },
      ])
    }, registry)

    await expect(client.sendMessage('Run too many')).rejects.toMatchObject({
      code: 'client_tool_batch_limit',
    })
    expect(requestCount).toBe(1)
    expect(executionCount).toBe(0)
  })

  test('clears session consent for a new session and does not transfer it to a replacement tool', async () => {
    let sessionCount = 0
    let authorizationCount = 0
    let callCount = 0
    const fetchMock = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/session')) {
        sessionCount += 1
        return Response.json({ sessionId: `session_${sessionCount}`, config })
      }
      if (url.pathname.endsWith('/chat')) {
        const body = await requestBody(init)
        if (body.resumeClientTurn === true) return sse([{ delta: 'Done.' }])
        callCount += 1
        const turnId = String(body.clientTurnId)
        return sse([
          toolCall(turnId, `call_${callCount}`, 'host_session_tool', {}, 'session'),
          { type: 'client_tool_pause', turnId, capability: `capability-${callCount}` },
        ])
      }
      throw new Error(`Unexpected mock URL: ${url}`)
    }) as typeof fetch
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: fetchMock,
      authorizeToolCall: () => {
        authorizationCount += 1
        return true
      },
    })
    const sessionTool = { ...tool('host_session_tool', async () => ({ source: 1 })), consent: 'session' as const }
    const unregister = client.registerTool(sessionTool)
    await client.createSession()
    await client.sendMessage('First')
    await client.sendMessage('Second')
    expect(authorizationCount).toBe(1)

    unregister()
    client.registerTool({ ...tool('host_session_tool', async () => ({ source: 2 })), consent: 'session' })
    await client.sendMessage('Replacement')
    expect(authorizationCount).toBe(2)

    await client.createSession()
    await client.sendMessage('New session')
    expect(authorizationCount).toBe(3)
  })

  test('rejects before executing tools when the signed capability is expiring', async () => {
    let executionCount = 0
    const registry = new ClientToolRegistry([
      tool('host_slow_step', async () => {
        executionCount += 1
        return { done: true }
      }),
    ])
    const client = await sessionClient(async (_url, init) => {
      const body = await requestBody(init)
      const turnId = String(body.clientTurnId)
      return sse([
        toolCall(turnId, 'call_expired', 'host_slow_step', {}),
        {
          type: 'client_tool_pause',
          turnId,
          capability: 'expiring-capability',
          expiresAt: Date.now() + 500,
        },
      ])
    }, registry)

    await expect(client.sendMessage('Expire')).rejects.toMatchObject({
      code: 'client_tool_capability_expired',
    })
    expect(executionCount).toBe(0)
  })

  test('keeps the capability deadline active while posting the resume request', async () => {
    const registry = new ClientToolRegistry([
      tool('host_quick_step', async () => ({ done: true })),
    ])
    const client = await sessionClient(async (_url, init) => {
      const body = await requestBody(init)
      if (body.resumeClientTurn === true) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init.signal
          if (!signal) return reject(new Error('Missing resume abort signal.'))
          if (signal.aborted) return reject(signal.reason)
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      const turnId = String(body.clientTurnId)
      return sse([
        toolCall(turnId, 'call_quick', 'host_quick_step', {}),
        {
          type: 'client_tool_pause',
          turnId,
          capability: 'short-capability',
          expiresAt: Date.now() + 2_100,
        },
      ])
    }, registry)

    await expect(client.sendMessage('Resume before expiry')).rejects.toMatchObject({
      code: 'client_tool_capability_expired',
    })
  })

  test('cancelling a partially streamed turn rejects instead of completing it', async () => {
    let sawDelta: (() => void) | undefined
    const deltaReceived = new Promise<void>((resolve) => { sawDelta = resolve })
    const encoder = new TextEncoder()
    const client = await sessionClient(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"delta":"Partial"}\n\n'))
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const completedAssistantMessages: string[] = []
    client.on('message_delta', () => sawDelta?.())
    client.on('message', (message) => {
      if (message.role === 'assistant') completedAssistantMessages.push(message.text)
    })

    const activeTurn = client.sendMessage('Start')
    await deltaReceived
    client.cancelActiveTurn()

    await expect(activeTurn).rejects.toMatchObject({ code: 'turn_cancelled' })
    expect(completedAssistantMessages).toEqual([])
    expect(client.state.messages.at(-1)?.text).toBe('Partial')
  })

  test('removes the pending assistant when HTTP fails before a delta', async () => {
    const client = await sessionClient(async () => new Response(
      JSON.stringify({ error: 'Mock failure' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    ))
    const completed: ChatEvent[] = []
    client.on('message', (message) => completed.push({ role: message.role, text: message.text }))

    await client.sendMessage('Fail please').catch(() => undefined)
    expect(client.state.messages.map((message) => message.role)).toEqual(['user'])
    expect(completed).toEqual([{ role: 'user', text: 'Fail please' }])
  })

  test('suppresses an empty assistant when a profile gate ends the stream', async () => {
    const client = await sessionClient(async () => sse([
      { type: 'profile_gate', reason: 'identity_required', disableInput: true },
    ]))
    const completed: ChatEvent[] = []
    client.on('message', (message) => completed.push({ role: message.role, text: message.text }))

    const response = await client.sendMessage('Continue')
    expect(response.text).toBe('')
    expect(client.state.status).toBe('ready')
    expect(client.state.messages.map((message) => message.role)).toEqual(['user'])
    expect(completed).toEqual([{ role: 'user', text: 'Continue' }])
  })

  test('hydrates campaign knowledge and recommended media into chat context', async () => {
    let chatBody: JsonObject | undefined
    const campaignConfig = { ...config, slidesEnabled: true, videosEnabled: true }
    const fetchMock = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/config')) return Response.json(campaignConfig)
      if (url.pathname.endsWith('/session')) {
        return Response.json({
          sessionId: 'session_campaign',
          config: campaignConfig,
          knowledgeKit: 'Campaign-specific governed knowledge',
          recommendedSlides: [
            { filename: 'roi.svg', title: 'ROI', slideType: 'proof', score: 0.98 },
          ],
          recommendedVideos: [
            { title: 'Warehouse tour', url: 'https://youtu.be/demo', sourceType: 'youtube_video' },
          ],
          personalization: {
            targetCompany: 'Acme Logistics',
            targetPerson: null,
            targetRole: null,
            targetIndustry: 'Logistics',
            agentMode: 'campaign',
            promptAdditions: 'Research context',
            firstMessage: '',
            knowledgeKit: null,
            recommendedSlides: [],
            talkTrack: [],
            challenges: ['Dwell time'],
            caseStudies: [],
          },
        })
      }
      if (url.pathname.endsWith('/slides/metadata')) {
        return Response.json({ slides: [{ filename: 'roi.svg', title: 'ROI', description: 'Proof', keyPoints: [] }] })
      }
      if (url.pathname.endsWith('/slides')) {
        return Response.json({ slides: [{ key: 'roi', filename: 'roi.svg', url: 'https://cdn.example/roi.svg' }] })
      }
      if (url.pathname.endsWith('/chat')) {
        chatBody = await requestBody(init)
        return sse([{ delta: 'Here is the relevant proof.' }])
      }
      throw new Error(`Unexpected mock URL: ${url}`)
    }) as typeof fetch
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: fetchMock,
    })

    await client.initialize({
      session: browserSession('https://acme.example/for/acme-logistics/'),
    })
    await client.sendMessage('Show me proof')

    expect(chatBody).toMatchObject({
      sessionId: 'session_campaign',
      message: 'Show me proof',
      knowledgeKit: 'Campaign-specific governed knowledge',
      recommendedSlides: [
        { filename: 'roi.svg', title: 'ROI', slideType: 'proof', score: 0.98 },
      ],
      recommendedVideos: [
        { title: 'Warehouse tour', url: 'https://youtu.be/demo', sourceType: 'youtube_video' },
      ],
      slides: [{ key: 'roi', filename: 'roi.svg', url: 'https://cdn.example/roi.svg' }],
      slideMetadata: {
        'roi.svg': { filename: 'roi.svg', title: 'ROI', description: 'Proof', keyPoints: [] },
      },
    })
  })

  test('syncs identity, behavior, page changes, and ElevenLabs ids through lifecycle APIs', async () => {
    const contextBodies: JsonObject[] = []
    let endBody: JsonObject | undefined
    const writeCapabilities: string[] = []
    let endCalls = 0
    let demoRequestBody: JsonObject | undefined
    const fetchMock = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/session')) {
        return Response.json({
          sessionId: 'session_lifecycle',
          sessionCapability: 'capability_session_lifecycle',
          config,
        })
      }
      if (url.pathname.endsWith('/identity')) {
        writeCapabilities.push(new Headers(init.headers).get('x-widget-session-capability') ?? '')
        return Response.json({ visitorId: 'visitor_1', enrichmentStatus: 'queued' })
      }
      if (url.pathname.endsWith('/context')) {
        writeCapabilities.push(new Headers(init.headers).get('x-widget-session-capability') ?? '')
        contextBodies.push(await requestBody(init))
        return Response.json({ ok: true })
      }
      if (url.pathname.endsWith('/visitor-intel')) {
        writeCapabilities.push(new Headers(init.headers).get('x-widget-session-capability') ?? '')
        return Response.json({ status: 'ready', companyName: 'Acme', summary: 'Warehouse operator.' })
      }
      if (url.pathname.endsWith('/demo-request')) {
        writeCapabilities.push(new Headers(init.headers).get('x-widget-session-capability') ?? '')
        demoRequestBody = await requestBody(init)
        return Response.json({ ok: true, submittedAt: '2026-07-15T00:00:00.000Z' })
      }
      if (url.pathname.endsWith('/session/end')) {
        endCalls += 1
        writeCapabilities.push(new Headers(init.headers).get('x-widget-session-capability') ?? '')
        endBody = await requestBody(init)
        return Response.json({ ok: true })
      }
      throw new Error(`Unexpected mock URL: ${url}`)
    }) as typeof fetch
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: fetchMock,
    })
    await client.createSession()

    await client.identify({ email: 'buyer@example.com', name: 'Buyer', industry: 'Logistics' })
    await client.track('pricing_viewed', { plan: 'enterprise' })
    await client.updatePage({ url: 'https://acme.example/pricing', title: 'Pricing' })
    const intel = await client.getVisitorIntel()
    const demoRequest = await client.submitDemoRequest({
      name: 'Buyer',
      email: 'Buyer@Example.com',
      company: 'Acme',
      context: 'Asked for a warehouse demo.',
    })
    client.linkElevenLabsConversation('conv_first')
    client.linkElevenLabsConversation('conv_second')
    const firstEnd = client.endSession({
      clientMessages: [
        { role: 'user', content: 'Show the ROI proof.' },
        { role: 'assistant', content: 'Here is the ROI slide.' },
      ],
      slidesViewed: ['roi.svg', 'roi.svg'],
    })
    const secondEnd = client.endSession()
    await Promise.all([firstEnd, secondEnd])

    expect(contextBodies[0]).toMatchObject({
      identity: { email: 'buyer@example.com', name: 'Buyer', industry: 'Logistics' },
      events: [],
    })
    expect(contextBodies.at(-1)?.events).toEqual([
      expect.objectContaining({ name: 'pricing_viewed', props: { plan: 'enterprise' } }),
      expect.objectContaining({
        name: 'page_view',
        props: { url: 'https://acme.example/pricing', title: 'Pricing' },
      }),
      expect.objectContaining({
        name: 'demo_request_submitted',
        props: {
          submittedAt: '2026-07-15T00:00:00.000Z',
          alreadySubmitted: false,
          identityLinked: true,
          hasCompany: true,
          hasPhone: false,
        },
      }),
    ])
    expect(endBody).toMatchObject({
      sessionId: 'session_lifecycle',
      elevenLabsConversationId: 'conv_second',
      elevenLabsConversationIds: ['conv_first', 'conv_second'],
      clientMessages: [
        { role: 'user', content: 'Show the ROI proof.' },
        { role: 'assistant', content: 'Here is the ROI slide.' },
      ],
      slidesViewed: ['roi.svg'],
      email: 'buyer@example.com',
      name: 'Buyer',
    })
    expect(intel).toMatchObject({ status: 'ready', companyName: 'Acme' })
    expect(demoRequest).toMatchObject({ ok: true, submittedAt: '2026-07-15T00:00:00.000Z' })
    expect(demoRequestBody).toMatchObject({
      sessionId: 'session_lifecycle',
      name: 'Buyer',
      email: 'buyer@example.com',
      company: 'Acme',
      context: 'Asked for a warehouse demo.',
    })
    expect(endCalls).toBe(1)
    expect(writeCapabilities).not.toContain('')
    expect(new Set(writeCapabilities)).toEqual(new Set(['capability_session_lifecycle']))
  })

  test('links demo identity from the response, emits a safe lifecycle event, and coalesces concurrent submits', async () => {
    let demoCalls = 0
    let identityCalls = 0
    let releaseDemo!: () => void
    const demoGate = new Promise<void>((resolve) => { releaseDemo = resolve })
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          return Response.json({
            sessionId: 'session_demo_linked',
            sessionCapability: 'capability_demo_linked',
            config,
          })
        }
        if (url.pathname.endsWith('/demo-request')) {
          demoCalls += 1
          await demoGate
          return Response.json({
            ok: true,
            alreadySubmitted: false,
            submittedAt: '2026-07-15T00:00:00.000Z',
            visitorId: 'visitor_demo_linked',
          })
        }
        if (url.pathname.endsWith('/identity')) {
          identityCalls += 1
          return Response.json({ visitorId: 'visitor_should_not_be_created' })
        }
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession()
    const lifecycle: unknown[] = []
    client.on('demo_request', (event) => lifecycle.push(event))

    const input = {
      name: 'Private Person',
      email: 'Private@Example.com',
      company: 'Private Company',
    }
    const first = client.submitDemoRequest(input)
    const second = client.submitDemoRequest(input)
    await Bun.sleep(0)
    releaseDemo()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult).toEqual(secondResult)
    expect(demoCalls).toBe(1)
    expect(identityCalls).toBe(0)
    expect(client.state.identity).toMatchObject({
      email: 'private@example.com',
      name: 'Private Person',
      company: 'Private Company',
    })
    expect(lifecycle).toEqual([{
      status: 'submitted',
      submittedAt: '2026-07-15T00:00:00.000Z',
      alreadySubmitted: false,
      identityLinked: true,
      hasCompany: true,
      hasPhone: false,
    }])
    expect(JSON.stringify(lifecycle)).not.toContain('private@example.com')
    expect(JSON.stringify(lifecycle)).not.toContain('Private Person')
    expect(JSON.stringify(lifecycle)).not.toContain('Private Company')
  })

  test('does not bind retry form PII when the session already has a demo identity', async () => {
    let identityCalls = 0
    const identityEvents: unknown[] = []
    const lifecycle: unknown[] = []
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          return Response.json({
            sessionId: 'session_demo_replay_privacy',
            sessionCapability: 'capability_demo_replay_privacy',
            config,
          })
        }
        if (url.pathname.endsWith('/demo-request')) {
          return Response.json({
            ok: true,
            alreadySubmitted: true,
            requestId: 'request_original',
            visitorId: 'visitor_original',
            submittedAt: '2026-07-15T00:00:00.000Z',
          })
        }
        if (url.pathname.endsWith('/identity')) {
          identityCalls += 1
          return Response.json({ visitorId: 'visitor_replacement' })
        }
        if (url.pathname.endsWith('/context')) return Response.json({ ok: true })
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession()
    client.on('identity', (event) => identityEvents.push(event))
    client.on('demo_request', (event) => lifecycle.push(event))

    const response = await client.submitDemoRequest({
      name: 'Replacement Person',
      email: 'replacement@example.com',
      company: 'Replacement Company',
    })

    expect(response).toMatchObject({ alreadySubmitted: true, visitorId: 'visitor_original' })
    expect(identityCalls).toBe(0)
    expect(identityEvents).toEqual([])
    expect(client.state.identity).toBeNull()
    expect(lifecycle).toEqual([expect.objectContaining({
      status: 'submitted',
      alreadySubmitted: true,
      identityLinked: true,
    })])
    expect(JSON.stringify(client.state)).not.toContain('replacement@example.com')
    expect(JSON.stringify(identityEvents)).not.toContain('Replacement Person')
  })

  test('does not fall back to identity capture for an opaque legacy replay acknowledgement', async () => {
    let identityCalls = 0
    const lifecycle: unknown[] = []
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          return Response.json({
            sessionId: 'session_demo_legacy_replay',
            sessionCapability: 'capability_demo_legacy_replay',
            config,
          })
        }
        if (url.pathname.endsWith('/demo-request')) {
          return Response.json({ ok: true, alreadySubmitted: true })
        }
        if (url.pathname.endsWith('/identity')) {
          identityCalls += 1
          return Response.json({ visitorId: 'visitor_replacement' })
        }
        if (url.pathname.endsWith('/context')) return Response.json({ ok: true })
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession()
    client.on('demo_request', (event) => lifecycle.push(event))

    await client.submitDemoRequest({
      name: 'Replacement Person',
      email: 'replacement@example.com',
    })

    expect(identityCalls).toBe(0)
    expect(client.state.identity).toBeNull()
    expect(lifecycle).toEqual([expect.objectContaining({
      status: 'submitted',
      alreadySubmitted: true,
      identityLinked: false,
    })])
  })

  test('reports an opened demo surface through the public lifecycle and authoritative timeline', async () => {
    const contextBodies: JsonObject[] = []
    const lifecycle: unknown[] = []
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          return Response.json({
            sessionId: 'session_demo_opened',
            sessionCapability: 'capability_demo_opened',
            config,
          })
        }
        if (url.pathname.endsWith('/context')) {
          contextBodies.push(await requestBody(init))
          return Response.json({ ok: true })
        }
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession()
    client.on('demo_request', (event) => lifecycle.push(event))

    client.reportDemoRequestOpened('custom_theme')
    await waitFor(() => contextBodies.length === 1)

    expect(lifecycle).toEqual([{ status: 'opened', surface: 'custom_theme' }])
    expect(contextBodies[0]?.events).toEqual([
      expect.objectContaining({
        name: 'demo_request_opened',
        props: { surface: 'custom_theme' },
      }),
    ])
  })

  test('falls back to canonical identity capture for the deployed legacy demo response', async () => {
    let identityBody: JsonObject | undefined
    const lifecycle: unknown[] = []
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          return Response.json({
            sessionId: 'session_demo_legacy',
            sessionCapability: 'capability_demo_legacy',
            config,
          })
        }
        if (url.pathname.endsWith('/demo-request')) return Response.json({ ok: true })
        if (url.pathname.endsWith('/identity')) {
          identityBody = await requestBody(init)
          return Response.json({ visitorId: 'visitor_demo_legacy' })
        }
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession()
    client.on('demo_request', (event) => lifecycle.push(event))

    await client.submitDemoRequest({
      name: 'Legacy Buyer',
      email: 'Legacy@Example.com',
      phone: '+1 415 555 0100',
      company: 'Legacy Co',
    })

    expect(identityBody).toMatchObject({
      sessionId: 'session_demo_legacy',
      name: 'Legacy Buyer',
      email: 'legacy@example.com',
      phone: '+1 415 555 0100',
      company: 'Legacy Co',
    })
    expect(client.state.identity).toMatchObject({
      name: 'Legacy Buyer',
      email: 'legacy@example.com',
      company: 'Legacy Co',
    })
    expect(lifecycle).toEqual([expect.objectContaining({
      status: 'submitted',
      identityLinked: true,
      hasCompany: true,
      hasPhone: true,
    })])
  })

  test('reports legacy identity-sync failure and safely retries the accepted handoff', async () => {
    let demoCalls = 0
    let identityCalls = 0
    const lifecycle: unknown[] = []
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          return Response.json({
            sessionId: 'session_demo_identity_retry',
            sessionCapability: 'capability_demo_identity_retry',
            config,
          })
        }
        if (url.pathname.endsWith('/demo-request')) {
          demoCalls += 1
          return Response.json({ ok: true })
        }
        if (url.pathname.endsWith('/identity')) {
          identityCalls += 1
          if (identityCalls === 1) {
            return Response.json({
              error: 'Identity service is unavailable.',
              code: 'identity_unavailable',
            }, { status: 503 })
          }
          return Response.json({ visitorId: 'visitor_demo_identity_retry' })
        }
        if (url.pathname.endsWith('/context')) return Response.json({ ok: true })
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession()
    client.on('demo_request', (event) => lifecycle.push(event))
    const input = { name: 'Retry Buyer', email: 'retry@example.com' }

    await expect(client.submitDemoRequest(input)).rejects.toThrow('Identity service is unavailable.')
    const response = await client.submitDemoRequest(input)

    expect(response).toMatchObject({ ok: true })
    expect(response.alreadySubmitted).toBeUndefined()
    expect(demoCalls).toBe(2)
    expect(identityCalls).toBe(2)
    expect(client.state.identity?.email).toBe('retry@example.com')
    expect(lifecycle).toEqual([
      {
        status: 'failed',
        stage: 'identity_sync',
        errorCode: 'identity_unavailable',
        hasCompany: false,
        hasPhone: false,
      },
      expect.objectContaining({
        status: 'submitted',
        alreadySubmitted: false,
        identityLinked: true,
      }),
    ])
  })

  test('reports an old-session identity-sync failure without contaminating the replacement session', async () => {
    let sessionCalls = 0
    let demoCalls = 0
    let contextCalls = 0
    let releaseFirstDemo!: () => void
    const firstDemoGate = new Promise<void>((resolve) => { releaseFirstDemo = resolve })
    const lifecycle: unknown[] = []
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          sessionCalls += 1
          return Response.json({
            sessionId: sessionCalls === 1 ? 'session_demo_old' : 'session_demo_replacement',
            sessionCapability: sessionCalls === 1 ? 'capability_demo_old' : 'capability_demo_replacement',
            config,
          })
        }
        if (url.pathname.endsWith('/demo-request')) {
          demoCalls += 1
          if (demoCalls === 1) await firstDemoGate
          return Response.json({
            ok: true,
            requestId: demoCalls === 1 ? 'request_old' : 'request_replacement',
            submittedAt: '2026-07-15T00:00:00.000Z',
            visitorId: demoCalls === 1 ? 'visitor_old' : 'visitor_replacement',
          })
        }
        if (url.pathname.endsWith('/context')) {
          contextCalls += 1
          return Response.json({ ok: true })
        }
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession()
    client.on('demo_request', (event) => lifecycle.push(event))
    const input = {
      name: 'Private Buyer',
      email: 'private@example.com',
      company: 'Private Company',
    }

    const oldSessionRequest = client.submitDemoRequest(input)
    await waitFor(() => demoCalls === 1)
    await client.createSession()
    releaseFirstDemo()
    await expect(oldSessionRequest).rejects.toMatchObject({ code: 'demo_request_session_changed' })

    expect(client.state.session?.sessionId).toBe('session_demo_replacement')
    expect(client.state.identity).toBeNull()
    expect(contextCalls).toBe(0)
    expect(lifecycle).toEqual([{
      status: 'failed',
      stage: 'identity_sync',
      errorCode: 'demo_request_session_changed',
      hasCompany: true,
      hasPhone: false,
    }])
    expect(JSON.stringify(lifecycle)).not.toContain('private@example.com')
    expect(JSON.stringify(lifecycle)).not.toContain('Private Buyer')
    expect(JSON.stringify(lifecycle)).not.toContain('Private Company')

    const retry = await client.submitDemoRequest(input)
    expect(retry.requestId).toBe('request_replacement')
    expect(demoCalls).toBe(2)
    expect(client.state.identity).toMatchObject({
      email: 'private@example.com',
      name: 'Private Buyer',
      company: 'Private Company',
    })
    expect(lifecycle.at(-1)).toMatchObject({
      status: 'submitted',
      requestId: 'request_replacement',
      identityLinked: true,
    })
  })

  test('emits the failed lifecycle stage without exposing submitted identity', async () => {
    const failures: unknown[] = []
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          return Response.json({
            sessionId: 'session_demo_failed',
            sessionCapability: 'capability_demo_failed',
            config,
          })
        }
        if (url.pathname.endsWith('/demo-request')) {
          return Response.json({ error: 'Demo delivery is unavailable.', code: 'demo_delivery_failed' }, { status: 503 })
        }
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession()
    client.on('demo_request', (event) => failures.push(event))

    await expect(client.submitDemoRequest({
      name: 'Private Person',
      email: 'private@example.com',
      company: 'Private Company',
    })).rejects.toThrow('Demo delivery is unavailable.')

    expect(failures).toEqual([expect.objectContaining({
      status: 'failed',
      stage: 'submission',
      hasCompany: true,
      hasPhone: false,
      errorCode: 'demo_delivery_failed',
    })])
    expect(JSON.stringify(failures)).not.toContain('private@example.com')
    expect(JSON.stringify(failures)).not.toContain('Private Person')
    expect(JSON.stringify(failures)).not.toContain('Private Company')
  })

  test('emits a safe lifecycle failure for client-side demo validation', async () => {
    const failures: unknown[] = []
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          return Response.json({
            sessionId: 'session_demo_invalid',
            sessionCapability: 'capability_demo_invalid',
            config,
          })
        }
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession()
    client.on('demo_request', (event) => failures.push(event))

    await expect(client.submitDemoRequest({
      name: 'x',
      email: 'private@example.com',
      company: 'Private Company',
    })).rejects.toThrow('at least two characters')

    expect(failures).toEqual([{
      status: 'failed',
      stage: 'submission',
      errorCode: 'invalid_demo_request',
      hasCompany: true,
      hasPhone: false,
    }])
    expect(JSON.stringify(failures)).not.toContain('private@example.com')
    expect(JSON.stringify(failures)).not.toContain('Private Company')
  })

  test('coalesces initialize calls and reuses one generated idempotency fingerprint', async () => {
    let resolveSession!: (response: Response) => void
    const sessionResponse = new Promise<Response>((resolve) => { resolveSession = resolve })
    const sessionBodies: JsonObject[] = []
    let sessionCalls = 0
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/config')) return Response.json(config)
        if (url.pathname.endsWith('/session')) {
          sessionCalls += 1
          sessionBodies.push(await requestBody(init))
          return sessionResponse
        }
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })

    const first = client.initialize({ loadMedia: false })
    const second = client.initialize({ loadMedia: false })
    await Bun.sleep(0)
    expect(sessionCalls).toBe(1)
    resolveSession(Response.json({ sessionId: 'session_single_flight', config }))
    const [firstState, secondState] = await Promise.all([first, second])

    expect(firstState.session?.sessionId).toBe('session_single_flight')
    expect(secondState.session?.sessionId).toBe('session_single_flight')
    expect(sessionBodies[0]?.fingerprint).toMatch(/^sdk_[A-Za-z0-9_-]+$/)
  })

  test('preserves an explicit caller fingerprint over the generated retry key', async () => {
    let body: JsonObject | undefined
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          body = await requestBody(init)
          return Response.json({ sessionId: 'session_explicit_fingerprint', config })
        }
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession({ fingerprint: 'host-owned-idempotency-key' })
    expect(body?.fingerprint).toBe('host-owned-idempotency-key')
  })

  test('bounds and allowlists every browser-controlled session bootstrap field', async () => {
    let body: JsonObject | undefined
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          body = await requestBody(init)
          return Response.json({ sessionId: 'session_bounded', config })
        }
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession({
      pageUrl: `https://shop.example/${'p'.repeat(3_000)}?token=secret#private`,
      referrer: `https://referrer.example/${'r'.repeat(3_000)}?email=buyer@example.com`,
      pageTitle: 'T'.repeat(1_000),
      fingerprint: 'F'.repeat(1_000),
      pid: 'P'.repeat(1_000),
      c: `Campaign ${'C'.repeat(200)}`,
      utmData: {
        utm_source: 'S'.repeat(1_000),
        utm_content: 'buyer@example.com',
        forged: 'must not pass',
      } as Record<string, string>,
      utm: { utm_medium: 'paid-social', utm_term: 'reset token secret' },
    })

    expect(String(body?.pageUrl)).toHaveLength(2_048)
    expect(String(body?.pageUrl)).not.toContain('token=')
    expect(String(body?.referrer)).toHaveLength(2_048)
    expect(String(body?.referrer)).not.toContain('buyer@example.com')
    expect(String(body?.pageTitle)).toHaveLength(256)
    expect(String(body?.fingerprint)).toHaveLength(128)
    expect(String(body?.pid)).toHaveLength(128)
    expect(String(body?.c).length).toBeLessThanOrEqual(64)
    expect(body?.utmData).toEqual({ utm_source: 'S'.repeat(256) })
    expect(body?.utm).toEqual({ utm_medium: 'paid-social' })
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThanOrEqual(64 * 1024)
  })

  test('rejects oversized chat messages, histories, and request bodies before chat fetch', async () => {
    let chatCalls = 0
    const makeClient = () => sessionClient(async () => {
      chatCalls += 1
      return sse([{ delta: 'unreachable' }])
    })

    await expect((await makeClient()).sendMessage('x'.repeat(8 * 1024 + 1)))
      .rejects.toMatchObject({ code: 'message_too_large' })
    await expect((await makeClient()).sendMessage('hello', {
      history: Array.from({ length: 21 }, (_, index) => ({
        role: index % 2 ? 'assistant' as const : 'user' as const,
        content: `turn ${index}`,
      })),
    })).rejects.toMatchObject({ code: 'chat_history_too_long' })
    await expect((await makeClient()).sendMessage('hello', {
      history: [{ role: 'user', content: 'x'.repeat(5 * 1024 + 1) }],
    })).rejects.toMatchObject({ code: 'chat_history_message_too_large' })
    await expect((await makeClient()).sendMessage('hello', {
      history: Array.from({ length: 14 }, () => ({ role: 'user' as const, content: 'x'.repeat(5_000) })),
    })).rejects.toMatchObject({ code: 'chat_history_too_large' })
    await expect((await makeClient()).sendMessage('hello', {
      context: { oversized: 'x'.repeat(260 * 1024) },
    })).rejects.toMatchObject({ code: 'chat_request_too_large' })
    expect(chatCalls).toBe(0)
  })

  test('destroy during an active turn cannot resurrect the client as errored', async () => {
    let notifyStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    const fetchMock = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/session')) {
        return Response.json({ sessionId: 'session_destroy', config })
      }
      if (url.pathname.endsWith('/chat')) {
        notifyStarted?.()
        return new Promise<Response>((_resolve, reject) => {
          const signal = init.signal
          if (!signal) return reject(new Error('Missing test abort signal.'))
          if (signal.aborted) return reject(signal.reason)
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      throw new Error(`Unexpected mock URL: ${url}`)
    }) as typeof fetch
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: fetchMock,
    })
    await client.createSession()

    const activeTurn = client.sendMessage('Wait forever')
    await started
    client.destroy()
    await expect(activeTurn).rejects.toMatchObject({ code: 'turn_cancelled' })
    expect(client.state.status).toBe('destroyed')
    expect(client.state.messages.map((message) => message.role)).toEqual(['user'])
    await expect(client.sendMessage('Try again')).rejects.toMatchObject({ code: 'client_destroyed' })
  })
})

interface ChatEvent { role: string; text: string }

function browserSession(pageUrl: string) {
  return { pageUrl, c: 'acme-logistics' }
}

async function sessionClient(
  chat: (url: URL, init: RequestInit) => Promise<Response>,
  tools = new ClientToolRegistry(),
): Promise<ConvincedClient> {
  const fetchMock = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/session')) {
      return Response.json({
        sessionId: 'session_123',
        sessionCapability: 'capability_session_123',
        config,
      })
    }
    if (url.pathname.endsWith('/chat')) return chat(url, init)
    throw new Error(`Unexpected mock URL: ${url}`)
  }) as typeof fetch
  const client = new ConvincedClient({
    orgSlug: 'demo',
    apiBase: 'https://mock.example',
    fetch: fetchMock,
    tools,
  })
  await client.createSession({ pageUrl: 'https://shop.example' })
  return client
}

function tool(name: string, handler: ClientTool['handler']): ClientTool {
  return {
    version: HOST_TOOL_PROTOCOL_VERSION,
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    locality: 'host',
    effect: 'read',
    consent: 'none',
    timeoutMs: 1_000,
    handler,
  }
}

function toolCall(
  turnId: string,
  id: string,
  name: string,
  args: JsonObject,
  consent: 'none' | 'session' | 'per_call' = 'none',
) {
  return {
    type: 'client_tool_call',
    turnId,
    call: {
      version: 1,
      id,
      name,
      args,
      locality: 'host',
      effect: 'read',
      consent,
    },
  }
}

function sse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

async function requestBody(init: RequestInit): Promise<JsonObject> {
  return JSON.parse(String(init.body)) as JsonObject
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for condition.')
    await Bun.sleep(1)
  }
}

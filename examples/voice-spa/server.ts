const port = Number(process.env.PORT ?? 4181)
const realAgentId = process.env.ELEVENLABS_AGENT_ID?.trim() || null

const state = {
  sessions: [] as Array<Record<string, unknown>>,
  contextUpdates: [] as Array<Record<string, unknown>>,
  endedSessions: [] as Array<Record<string, unknown>>,
  chatMessages: [] as string[],
  mcpCalls: [] as Array<Record<string, unknown>>,
}

const config = {
  orgName: 'Relay Systems',
  orgSlug: 'voice-spa-demo',
  agentName: 'Relay voice guide',
  agentTitle: 'Live product navigator',
  voiceEnabled: true,
  voiceMode: 'always_voice',
  voiceProvider: 'elevenlabs',
  elevenLabsAgentId: realAgentId,
  voiceCtaText: 'Talk to the product guide',
  slidesEnabled: false,
  videosEnabled: false,
  suggestedQuestions: ['Open pricing', 'Show me customer proof'],
  primaryColor: '#ff5c35',
  accentColor: '#2de2a6',
  showPoweredBy: true,
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)

    if (request.method === 'GET' && ['/home', '/pricing', '/case-study', '/'].includes(url.pathname)) {
      return asset('index.html')
    }
    if (request.method === 'GET' && url.pathname === '/styles.css') return asset('styles.css')
    if (request.method === 'GET' && url.pathname === '/app.js') return asset('app.js')
    if (request.method === 'GET' && url.pathname === '/shared/mock-elevenlabs.js') {
      return sharedAsset('mock-elevenlabs.js')
    }
    if (request.method === 'GET' && url.pathname === '/sdk.js') {
      return new Response(Bun.file(new URL('../../dist/convinced-widget.global.js', import.meta.url)), {
        headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
      })
    }
    if (request.method === 'GET' && url.pathname === '/api/demo-state') {
      return Response.json({ ...state, realVoiceConfigured: Boolean(realAgentId) })
    }
    if (request.method === 'GET' && url.pathname === '/api/widget/voice-spa-demo/config') {
      return Response.json(config)
    }
    if (request.method === 'POST' && url.pathname === '/api/widget/voice-spa-demo/session') {
      const input = await jsonBody(request)
      state.sessions.push(input)
      const campaign = typeof input.c === 'string' && input.c ? input.c : 'organic'
      return Response.json({
        sessionId: `voice_spa_${state.sessions.length}`,
        config,
        knowledgeKit: 'relay-product-overview',
        personalization: {
          targetCompany: campaign === 'northstar-rollout' ? 'Northstar Logistics' : null,
          targetPerson: null,
          targetRole: 'Operations leader',
          targetIndustry: 'B2B software',
          agentMode: campaign === 'northstar-rollout' ? 'campaign' : 'inbound',
          promptAdditions: 'Prefer voice. Use host tools when showing product proof.',
          firstMessage: campaign === 'northstar-rollout'
            ? 'I can walk you through the rollout built for Northstar.'
            : 'I can guide you through Relay by voice.',
          knowledgeKit: 'relay-product-overview',
          recommendedSlides: [],
          talkTrack: ['Start with the visitor intent', 'Demonstrate in the current page'],
          challenges: ['Long evaluation cycles'],
          caseStudies: [{ customer: 'Northstar', reason: 'Faster time to first value' }],
        },
      })
    }
    if (request.method === 'POST' && /^\/api\/widget\/voice-spa-demo\/session\/[^/]+\/context$/.test(url.pathname)) {
      state.contextUpdates.push(await jsonBody(request))
      return Response.json({ ok: true })
    }
    if (request.method === 'POST' && url.pathname === '/api/widget/voice-spa-demo/session/end') {
      state.endedSessions.push(await jsonBody(request))
      return Response.json({ ok: true })
    }
    if (request.method === 'POST' && url.pathname === '/api/widget/voice-spa-demo/identity') {
      return Response.json({ visitorId: 'voice_spa_visitor', enrichmentStatus: 'queued' })
    }
    if (request.method === 'POST' && url.pathname === '/api/widget/voice-spa-demo/chat') {
      const body = await jsonBody(request)
      const message = typeof body.message === 'string' ? body.message : ''
      state.chatMessages.push(message)
      const response = message.toLowerCase().includes('proof')
        ? 'Northstar cut time to first value by 42%. Voice can open and highlight the full proof on this page.'
        : message.toLowerCase().includes('pricing')
          ? 'The Enterprise plan includes rollout design. Start voice to let the guide open and highlight it.'
          : 'I can answer here, but voice is the primary path in this example. Ask about pricing or customer proof.'
      return sse([{ delta: response }])
    }
    if (request.method === 'POST' && url.pathname === '/api/mcp/inventory') {
      const body = await jsonBody(request)
      state.mcpCalls.push(body)
      const arguments_ = body.arguments && typeof body.arguments === 'object'
        ? body.arguments as Record<string, unknown>
        : {}
      return Response.json({
        content: [{
          type: 'text',
          text: arguments_.sku === 'enterprise'
            ? 'Enterprise guided rollouts are available this quarter.'
            : 'No matching public demo availability.',
        }],
      })
    }

    return new Response('Not found', { status: 404 })
  },
})

console.log(`Voice-first SPA example: http://localhost:${server.port}/home?c=northstar-rollout&utm_source=sample&utm_campaign=voice-sdk`)

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json()
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function sse(events: unknown[]): Response {
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  })
}

function asset(name: string): Response {
  return fileResponse(new URL(`./${name}`, import.meta.url), name)
}

function sharedAsset(name: string): Response {
  return fileResponse(new URL(`../shared/${name}`, import.meta.url), name)
}

function fileResponse(url: URL, name: string): Response {
  const contentType = name.endsWith('.css')
    ? 'text/css; charset=utf-8'
    : name.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : 'text/html; charset=utf-8'
  return new Response(Bun.file(url), { headers: { 'Content-Type': contentType } })
}

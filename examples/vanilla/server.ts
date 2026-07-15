const port = Number(process.env.PORT ?? 4173)
const capability = 'demo.opaque-continuation.v1'

const state = {
  initialChatRequests: 0,
  continuationRequests: 0,
  identitySubmissions: [] as unknown[],
  lastClientTurnId: '',
  lastToolResults: [] as unknown[],
}

const config = {
  orgName: 'Fieldworks Robotics',
  orgSlug: 'demo',
  agentName: 'Floor specialist',
  slidesEnabled: true,
  videosEnabled: true,
  suggestedQuestions: ['Show me how Atlas worked in a real warehouse'],
  primaryColor: '#d75a36',
  accentColor: '#fffaf2',
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/') return file('index.html')
    if (request.method === 'GET' && url.pathname === '/styles.css') return file('styles.css')
    if (request.method === 'GET' && url.pathname === '/app.js') return file('app.js')
    if (request.method === 'GET' && url.pathname === '/sdk.js') {
      return new Response(Bun.file(new URL('../../dist/convinced-widget.global.js', import.meta.url)), {
        headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
      })
    }
    if (request.method === 'GET' && url.pathname === '/assets/warehouse-automation.svg') {
      return new Response(Bun.file(new URL('./assets/warehouse-automation.svg', import.meta.url)), {
        headers: { 'Content-Type': 'image/svg+xml' },
      })
    }
    if (request.method === 'GET' && url.pathname === '/api/demo-state') return Response.json(state)
    if (request.method === 'GET' && url.pathname === '/api/widget/demo/config') return Response.json(config)

    if (request.method === 'POST' && url.pathname === '/api/widget/demo/session') {
      return Response.json({
        sessionId: 'session_storefront_demo',
        knowledgeKit: 'fieldworks-demo',
        config,
      })
    }

    if (request.method === 'GET' && url.pathname === '/api/widget/demo/slides') {
      return Response.json({
        slides: [{
          key: 'slides/warehouse-automation.svg',
          filename: 'warehouse-automation.svg',
          url: `${url.origin}/assets/warehouse-automation.svg`,
        }],
      })
    }

    if (request.method === 'GET' && url.pathname === '/api/widget/demo/slides/metadata') {
      return Response.json({
        slides: [{
          filename: 'warehouse-automation.svg',
          title: 'The four-step warehouse rollout',
          description: 'Map, connect, prove, then scale.',
          keyPoints: ['Start with one painful route', 'Keep exception control', 'Scale after measured proof'],
          slideType: 'process',
        }],
      })
    }

    if (request.method === 'POST' && url.pathname === '/api/widget/demo/identity') {
      const body = await jsonBody(request)
      if (typeof body.email !== 'string' || !body.email.includes('@')) {
        return Response.json({ error: 'A valid email is required.' }, { status: 400 })
      }
      state.identitySubmissions.push(body)
      return Response.json({ visitorId: `visitor_${state.identitySubmissions.length}`, enrichmentStatus: 'queued' })
    }

    if (request.method === 'POST' && url.pathname === '/api/widget/demo/chat') {
      const body = await jsonBody(request)
      if (body.resumeClientTurn === true) return resumeChat(body)
      return startChat(body)
    }

    return new Response('Not found', { status: 404 })
  },
})

console.log(`Convinced Widget SDK sample: http://localhost:${server.port}`)

function startChat(body: Record<string, unknown>): Response {
  const tools = Array.isArray(body.clientTools) ? body.clientTools as Array<Record<string, unknown>> : []
  const names = new Set(tools.map((tool) => tool.name))
  const turnId = typeof body.clientTurnId === 'string' ? body.clientTurnId : ''
  if (
    turnId.length < 8 ||
    !names.has('host_scroll_to') ||
    !names.has('host_highlight') ||
    body.resumeClientTurn !== undefined
  ) {
    return Response.json({
      error: 'The sample requires the canonical host tool manifest and a stable clientTurnId.',
    }, { status: 400 })
  }
  state.initialChatRequests += 1
  state.lastClientTurnId = turnId
  return sse([
    {
      type: 'client_tool_call',
      turnId,
      call: {
        version: 1,
        id: `scroll_${state.initialChatRequests}`,
        name: 'host_scroll_to',
        args: { selector: '#featured-robot', behavior: 'smooth', block: 'center' },
        locality: 'host',
        effect: 'mutate',
        consent: 'per_call',
      },
    },
    {
      type: 'client_tool_call',
      turnId,
      call: {
        version: 1,
        id: `highlight_${state.initialChatRequests}`,
        name: 'host_highlight',
        args: { selector: '#featured-robot', color: '#d75a36', durationMs: 8_000 },
        locality: 'host',
        effect: 'mutate',
        consent: 'per_call',
      },
    },
    { type: 'client_tool_pause', turnId, capability, expiresAt: Date.now() + 60_000 },
  ])
}

function resumeChat(body: Record<string, unknown>): Response {
  const results = Array.isArray(body.clientToolResults) ? body.clientToolResults as Array<Record<string, unknown>> : []
  const validResults = results.length === 2 && results.every((result) => result.version === 1 && result.ok === true)
  if (
    body.clientTurnId !== state.lastClientTurnId ||
    body.clientToolCapability !== capability ||
    !validResults
  ) {
    return Response.json({ error: 'Invalid opaque continuation or host tool results.' }, { status: 400 })
  }
  state.continuationRequests += 1
  state.lastToolResults = results
  return sse([
    { type: 'profile_gate', reason: 'send_rollout_brief', disableInput: false },
    {
      delta: [
        'That highlighted deployment is a good match for the workflow you asked about. Atlas started with one cross-dock route, proved the dwell-time reduction, then expanded without fixed infrastructure.\n\n',
        '[SLIDE:warehouse-automation.svg]\n',
        '[VIDEO:https://www.youtube.com/watch?v=M7lc1UVf-VE|Watch the fleet workflow]',
      ].join(''),
    },
  ])
}

function sse(events: unknown[]): Response {
  const stream = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  })
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json()
    return value && !Array.isArray(value) && typeof value === 'object'
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function file(name: string): Response {
  const contentType = name.endsWith('.css')
    ? 'text/css; charset=utf-8'
    : name.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : 'text/html; charset=utf-8'
  return new Response(Bun.file(new URL(`./${name}`, import.meta.url)), {
    headers: { 'Content-Type': contentType },
  })
}

const port = Number(process.env.PORT ?? 4182)

const state = {
  sessions: [] as Array<Record<string, unknown>>,
  contextUpdates: [] as Array<Record<string, unknown>>,
  identities: [] as Array<Record<string, unknown>>,
  endedSessions: [] as Array<Record<string, unknown>>,
  messages: [] as string[],
}

const pills = [
  { id: 'craft', label: 'Why made-to-order?', color: '#9f402b', productName: 'Morrow', prompt: 'Show me why made-to-order matters.', order: 0 },
  { id: 'lookbook', label: 'Open my private lookbook', color: '#29231e', productName: 'Lookbook', prompt: 'Show the private lookbook slide.', order: 1 },
  { id: 'film', label: 'Play the Rosehip story', color: '#d1b88f', productName: 'Film', prompt: 'Show me the Rosehip House film.', order: 2 },
]

const config = {
  orgName: 'Morrow House',
  orgSlug: 'custom-brand-demo',
  agentName: 'Morrow concierge',
  agentTitle: 'Private commissions',
  voiceEnabled: true,
  voiceMode: 'always_voice',
  voiceProvider: 'elevenlabs',
  elevenLabsAgentId: null,
  slidesEnabled: true,
  videosEnabled: true,
  primaryColor: '#9f402b',
  accentColor: '#e9dfcd',
  firstMessageEnabled: true,
  firstMessageText: 'Welcome to the private preview. Would you rather begin with materials, a room story, or a commission?',
  pillsConfig: {
    enabled: true,
    warmupExchanges: 0,
    emailGateMessage: 'Where should we send your private lookbook?',
    initialPillCount: 3,
    pills,
  },
  identityCaptureAfterExchanges: 1,
  suggestedQuestions: pills.map((pill) => pill.label),
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === 'GET' && ['/', '/pricing', '/case-study', '/home'].includes(url.pathname)) return asset('index.html')
    if (request.method === 'GET' && url.pathname === '/styles.css') return asset('styles.css')
    if (request.method === 'GET' && url.pathname === '/app.js') return asset('app.js')
    if (request.method === 'GET' && url.pathname === '/shared/mock-elevenlabs.js') return sharedAsset('mock-elevenlabs.js')
    if (request.method === 'GET' && url.pathname === '/assets/morrow-lookbook.svg') return asset('assets/morrow-lookbook.svg')
    if (request.method === 'GET' && url.pathname === '/sdk.js') {
      return new Response(Bun.file(new URL('../../dist/convinced-widget.global.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } })
    }
    if (request.method === 'GET' && url.pathname === '/api/demo-state') return Response.json(state)
    if (request.method === 'GET' && url.pathname === '/api/widget/custom-brand-demo/config') return Response.json(config)
    if (request.method === 'POST' && url.pathname === '/api/widget/custom-brand-demo/session') {
      const input = await jsonBody(request)
      state.sessions.push(input)
      const token = typeof input.c === 'string' && input.c ? input.c : 'atelier-private-preview'
      return Response.json({
        sessionId: `morrow_${state.sessions.length}`,
        config,
        knowledgeKit: 'morrow-private-collection',
        recommendedSlides: [{ filename: 'morrow-lookbook.svg', title: 'Morrow private lookbook', slideType: 'lookbook', score: 0.98 }],
        recommendedVideos: [{ title: 'Rosehip House', url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE', sourceType: 'youtube_video', score: 0.92 }],
        personalization: {
          targetCompany: token === 'atelier-private-preview' ? 'Atelier North' : null,
          targetPerson: 'Elena',
          targetRole: 'Creative director',
          targetIndustry: 'Interiors',
          agentMode: 'campaign',
          promptAdditions: 'Use a quiet consultative tone. Prefer voice and visual proof.',
          firstMessage: 'Elena, welcome to the collection prepared for Atelier North.',
          knowledgeKit: 'morrow-private-collection',
          recommendedSlides: [{ filename: 'morrow-lookbook.svg', title: 'Morrow private lookbook', slideType: 'lookbook', score: 0.98 }],
          talkTrack: ['Material longevity', 'Morning light', 'Private commission'],
          challenges: ['Sourcing pieces that age well'],
          caseStudies: [{ customer: 'Rosehip House', reason: 'A complete room shaped around changing light' }],
        },
      })
    }
    if (request.method === 'GET' && url.pathname === '/api/widget/custom-brand-demo/slides') {
      return Response.json({ slides: [{ key: 'slides/morrow-lookbook.svg', filename: 'morrow-lookbook.svg', url: `${url.origin}/assets/morrow-lookbook.svg` }] })
    }
    if (request.method === 'GET' && url.pathname === '/api/widget/custom-brand-demo/slides/metadata') {
      return Response.json({ slides: [{ filename: 'morrow-lookbook.svg', title: 'Morrow private lookbook', description: 'Objects, materials, and room stories selected for Atelier North.', keyPoints: ['English ash', 'Natural finish', 'Made to order'], slideType: 'lookbook' }] })
    }
    if (request.method === 'POST' && /^\/api\/widget\/custom-brand-demo\/session\/[^/]+\/context$/.test(url.pathname)) {
      state.contextUpdates.push(await jsonBody(request)); return Response.json({ ok: true })
    }
    if (request.method === 'POST' && url.pathname === '/api/widget/custom-brand-demo/session/end') {
      state.endedSessions.push(await jsonBody(request)); return Response.json({ ok: true })
    }
    if (request.method === 'POST' && url.pathname === '/api/widget/custom-brand-demo/identity') {
      const body = await jsonBody(request); state.identities.push(body)
      return Response.json({ visitorId: `morrow_visitor_${state.identities.length}`, enrichmentStatus: 'queued' })
    }
    if (request.method === 'POST' && url.pathname === '/api/widget/custom-brand-demo/chat') {
      const body = await jsonBody(request)
      const message = typeof body.message === 'string' ? body.message : ''
      state.messages.push(message)
      const normalized = message.toLowerCase()
      const reply = normalized.includes('film') || normalized.includes('rosehip')
        ? 'Rosehip House begins with the east-facing room. Watch how the collection follows the morning light.\n\n[VIDEO:https://www.youtube.com/watch?v=M7lc1UVf-VE|Rosehip House — a room in morning light]'
        : normalized.includes('lookbook') || normalized.includes('slide')
          ? 'I selected the private lookbook prepared for this campaign.\n\n[SLIDE:morrow-lookbook.svg]'
          : 'Made-to-order lets each joint, finish, and proportion answer the room—not an inventory forecast. Would you like the private lookbook or the Rosehip House film?'
      return sse([{ delta: reply }])
    }
    return new Response('Not found', { status: 404 })
  },
})

console.log(`Custom-brand example: http://localhost:${server.port}/?c=atelier-private-preview&utm_source=studio-letter`)

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try { const value: unknown = await request.json(); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} } catch { return {} }
}
function sse(events: unknown[]): Response { return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }) }
function asset(name: string): Response { return fileResponse(new URL(`./${name}`, import.meta.url), name) }
function sharedAsset(name: string): Response { return fileResponse(new URL(`../shared/${name}`, import.meta.url), name) }
function fileResponse(url: URL, name: string): Response {
  const type = name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8'
  return new Response(Bun.file(url), { headers: { 'Content-Type': type } })
}

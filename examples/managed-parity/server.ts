const port = Number(process.env.PORT ?? 4183)
const realAgentId = process.env.ELEVENLABS_AGENT_ID?.trim() || null
const state = { sessions: [] as unknown[], contextUpdates: [] as unknown[], identities: [] as unknown[], ended: [] as unknown[], chats: [] as string[] }

const baseConfig = {
  orgName: 'Arcwell', orgSlug: 'managed-parity-demo', agentName: 'Maya', agentTitle: 'Arcwell product specialist',
  voiceEnabled: true, voiceMode: 'always_voice', voiceProvider: 'elevenlabs', elevenLabsAgentId: realAgentId,
  voiceCtaText: 'Talk with Maya', slidesEnabled: true, videosEnabled: true, primaryColor: '#175c52', accentColor: '#e7f0eb',
  greetingMessage: 'Hi—I can help you find the right Arcwell proof.', widgetVersion: 'v2', v2Theme: 'frost-glass',
  launcherStyle: 'ticker', launcherPosition: 'bottom-right', launcherCta: 'Ask Maya', expandEnabled: true,
  expandGlowColor: '#c85b39',
  launcherCalloutEnabled: true, launcherCallout: 'Explore an enterprise rollout', launcherPulseEnabled: true,
  tickerLines: ['Map buyer signals', 'Governed browser tools', 'Voice-first product proof'],
  tickerColor: '#c85b39', tickerLuxStyle: 'mercury', tickerBarEnabled: true, tickerIntroEnabled: true,
  firstMessageEnabled: true, firstMessageText: 'I can walk you through Arcwell by voice or answer here.',
  showPoweredBy: true, identityCaptureAfterExchanges: 1,
  returnVisitorEnabled: true, returnVisitorDays: 30,
  returnVisitorGreeting: 'Welcome back, {name}. Want to continue with {topic}?',
  suggestedQuestions: ['Show me relevant customer proof', 'How does enterprise rollout work?'],
  meetingCtaText: 'Design my rollout', meetingCtaUrl: 'https://example.com/arcwell-demo',
  engagementTriggers: {
    emailCapture: { enabled: true, mode: 'rules', pillText: 'Send the rollout brief', afterMessages: 1 },
    resourceOffer: { enabled: true, mode: 'both', pillText: 'See rollout resources' },
    meetingCta: { enabled: true, mode: 'rules', pillText: 'Design my rollout' },
  },
  pillsConfig: {
    enabled: true, warmupExchanges: 0, emailGateMessage: 'Where should Maya send the rollout brief?', initialPillCount: 3,
    welcomeCard: {
      tagline: 'A voice-first Arcwell rollout brief',
      stats: [{ value: '46', label: 'teams aligned' }, { value: '-28%', label: 'sales cycle' }],
      customerLogos: [{ name: 'Northstar', logoUrl: '' }, { name: 'Meridian', logoUrl: '' }],
      ctaText: 'Start with voice',
      backgroundColor: '#eef5f1',
    },
    pills: [
      { id: 'proof', label: 'Customer proof', color: '#175c52', productName: 'Arcwell', prompt: 'Show me relevant customer proof.', order: 0 },
      { id: 'rollout', label: 'Rollout plan', color: '#c85b39', productName: 'Arcwell', prompt: 'How does enterprise rollout work?', order: 1 },
      { id: 'video', label: 'Watch overview', color: '#1c2c34', productName: 'Arcwell', prompt: 'Show the platform overview video.', order: 2 },
    ],
  },
}

const campaignConfig = {
  ...baseConfig,
  launcherCallout: 'See the Lumen rollout proof',
  tickerLines: ['Lumen: 28% shorter cycle', '46 teams aligned', 'Voice-first product proof'],
  suggestedQuestions: ['Show me the Lumen customer proof', 'How does enterprise rollout work?'],
  pillsConfig: {
    ...baseConfig.pillsConfig,
    welcomeCard: {
      ...baseConfig.pillsConfig.welcomeCard,
      tagline: 'A voice-first rollout brief for Lumen Group',
      customerLogos: [{ name: 'Lumen Group', logoUrl: '' }, { name: 'Northstar', logoUrl: '' }],
    },
    pills: [
      { id: 'proof', label: 'Lumen proof', color: '#175c52', productName: 'Arcwell', prompt: 'Show me the Lumen customer proof.', order: 0 },
      { id: 'rollout', label: 'Rollout plan', color: '#c85b39', productName: 'Arcwell', prompt: 'How does enterprise rollout work?', order: 1 },
      { id: 'video', label: 'Watch overview', color: '#1c2c34', productName: 'Arcwell', prompt: 'Show the platform overview video.', order: 2 },
    ],
  },
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/') return asset('index.html')
    if (request.method === 'GET' && url.pathname === '/styles.css') return asset('styles.css')
    if (request.method === 'GET' && url.pathname === '/app.js') return asset('app.js')
    if (request.method === 'GET' && url.pathname === '/shared/mock-elevenlabs.js') return shared('mock-elevenlabs.js')
    if (request.method === 'GET' && url.pathname === '/assets/arcwell-proof.svg') return asset('assets/arcwell-proof.svg')
    if (request.method === 'GET' && url.pathname === '/sdk.js') return new Response(Bun.file(new URL('../../dist/convinced-widget.global.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } })
    if (request.method === 'GET' && url.pathname === '/api/demo-state') return Response.json(state)
    if (request.method === 'GET' && url.pathname === '/api/widget/managed-parity-demo/config') return Response.json(baseConfig)
    if (request.method === 'POST' && url.pathname === '/api/widget/managed-parity-demo/session') {
      const input = await jsonBody(request); state.sessions.push(input)
      const campaignToken = typeof input.c === 'string' ? input.c.trim() : ''
      if (!campaignToken) {
        return Response.json({
          sessionId: `arcwell_${state.sessions.length}`,
          config: baseConfig,
          knowledgeKit: null,
          recommendedSlides: [],
          recommendedVideos: [],
          personalization: {
            targetCompany: null, targetPerson: null, targetRole: null, targetIndustry: null,
            agentMode: 'inbound', promptAdditions: '', firstMessage: '', knowledgeKit: null,
            recommendedSlides: [], talkTrack: [], challenges: [], caseStudies: [],
          },
        })
      }
      return Response.json({ sessionId: `arcwell_${state.sessions.length}`, config: campaignConfig, knowledgeKit: 'arcwell-lumen-campaign', recommendedSlides: [{ filename: 'arcwell-proof.svg', title: 'Lumen rollout proof', slideType: 'case-study', score: .99 }], recommendedVideos: [{ title: 'Arcwell in 90 seconds', url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE', sourceType: 'youtube_video' }], personalization: { targetCompany: 'Lumen Group', targetPerson: 'Jordan', targetRole: 'Revenue operations', targetIndustry: 'Enterprise software', agentMode: 'campaign', promptAdditions: 'Lead with Lumen proof and voice.', firstMessage: 'Jordan, I pulled together the Lumen rollout proof for your team.', knowledgeKit: 'arcwell-lumen-campaign', recommendedSlides: [{ filename: 'arcwell-proof.svg', title: 'Lumen rollout proof', slideType: 'case-study', score: .99 }], talkTrack: ['Cross-team signal alignment', 'Measured rollout'], challenges: ['Fragmented buying signals'], caseStudies: [{ customer: 'Lumen', reason: '28% shorter sales cycle' }] } })
    }
    if (request.method === 'GET' && url.pathname === '/api/widget/managed-parity-demo/slides') return Response.json({ slides: [{ key: 'slides/arcwell-proof.svg', filename: 'arcwell-proof.svg', url: `${url.origin}/assets/arcwell-proof.svg` }] })
    if (request.method === 'GET' && url.pathname === '/api/widget/managed-parity-demo/slides/metadata') return Response.json({ slides: [{ filename: 'arcwell-proof.svg', title: 'Lumen rollout proof', description: 'A two-quarter enterprise rollout.', keyPoints: ['46 teams', '28% shorter cycle', 'One signal model'], slideType: 'case-study' }] })
    if (request.method === 'POST' && /^\/api\/widget\/managed-parity-demo\/session\/[^/]+\/context$/.test(url.pathname)) { state.contextUpdates.push(await jsonBody(request)); return Response.json({ ok: true }) }
    if (request.method === 'POST' && url.pathname === '/api/widget/managed-parity-demo/session/end') { state.ended.push(await jsonBody(request)); return Response.json({ ok: true }) }
    if (request.method === 'GET' && url.pathname === '/api/widget/managed-parity-demo/visitor-intel') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const sessionIndex = Number(sessionId.replace(/^arcwell_/, '')) - 1
      const sessionInput = state.sessions[sessionIndex]
      if (!sessionInput || typeof sessionInput !== 'object') {
        return Response.json({ error: 'Unknown sample session' }, { status: 404 })
      }
      const campaignToken = typeof (sessionInput as Record<string, unknown>).c === 'string'
        ? String((sessionInput as Record<string, unknown>).c).trim()
        : ''
      if (!campaignToken) return Response.json({ status: 'unavailable' })
      return Response.json({
        status: 'ready',
        companyName: 'Lumen Group',
        industry: 'Enterprise software',
        summary: 'Lumen is aligning revenue teams around one governed buying-signal model.',
        sources: [{ title: 'Arcwell Lumen rollout proof', url: `${url.origin}/assets/arcwell-proof.svg` }],
      })
    }
    if (request.method === 'POST' && url.pathname === '/api/widget/managed-parity-demo/identity') { state.identities.push(await jsonBody(request)); return Response.json({ visitorId: `arcwell_visitor_${state.identities.length}`, enrichmentStatus: 'queued' }) }
    if (request.method === 'POST' && url.pathname === '/api/widget/managed-parity-demo/chat') {
      const body = await jsonBody(request); const message = typeof body.message === 'string' ? body.message : ''; state.chats.push(message)
      const normalized = message.toLowerCase(); const reply = normalized.includes('video') ? 'Here is the short platform overview.\n\n[VIDEO:https://www.youtube.com/watch?v=M7lc1UVf-VE|Arcwell in 90 seconds]' : normalized.includes('proof') || normalized.includes('lumen') ? 'Lumen aligned 46 teams around one buying-signal model and shortened its sales cycle by 28% in two quarters.\n\n[SLIDE:arcwell-proof.svg]' : 'Enterprise rollout starts with one measurable buying motion, a bounded tool policy, and an evaluation trace. The Lumen proof shows the full pattern.'
      return sse([{ delta: reply }])
    }
    return new Response('Not found', { status: 404 })
  },
})

console.log(`Default SDK composition: http://localhost:${server.port}/?c=lumen-expansion&utm_campaign=q3-enterprise`)

async function jsonBody(request: Request): Promise<Record<string, unknown>> { try { const value: unknown = await request.json(); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} } catch { return {} } }
function sse(events: unknown[]): Response { return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }) }
function asset(name: string): Response { return file(new URL(`./${name}`, import.meta.url), name) }
function shared(name: string): Response { return file(new URL(`../shared/${name}`, import.meta.url), name) }
function file(url: URL, name: string): Response { const type = name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8'; return new Response(Bun.file(url), { headers: { 'Content-Type': type } }) }

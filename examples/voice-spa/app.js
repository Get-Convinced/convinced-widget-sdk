import { createMockConversationFactory } from '/shared/mock-elevenlabs.js'

const SDK = window.ConvincedWidgetSDK
if (!SDK) throw new Error('Build the SDK before running this example.')
window.__voiceSpaBoot = { phase: 'script-started' }

const app = document.querySelector('#app')
const traceList = document.querySelector('#activity-trace')
const voiceStatus = document.querySelector('#voice-status')
const voiceCaption = document.querySelector('#voice-caption')
const voiceModeBadge = document.querySelector('#voice-mode-badge')
const startButton = document.querySelector('#voice-start')
const pricingButton = document.querySelector('#ask-pricing')
const proofButton = document.querySelector('#ask-proof')
const inventoryButton = document.querySelector('#ask-inventory')
const muteButton = document.querySelector('#voice-mute')
const endButton = document.querySelector('#voice-end')
const chatMessages = document.querySelector('#chat-messages')
const initialUrl = new URL(window.location.href)
const requestedRealVoice = initialUrl.searchParams.get('voice') === 'real'
const traceEntries = []
let voice = null
let muted = false

function trace(label, detail = '') {
  const entry = { at: new Date().toISOString(), label, detail }
  traceEntries.push(entry)
  const item = document.createElement('li')
  item.innerHTML = `<time>${new Date().toLocaleTimeString([], { hour12: false })}</time><span>${escapeHtml(label)}</span>${detail ? `<code>${escapeHtml(detail)}</code>` : ''}`
  traceList.prepend(item)
  while (traceList.children.length > 14) traceList.lastElementChild?.remove()
}

function currentPath(pathname = window.location.pathname) {
  return ['/home', '/pricing', '/case-study'].includes(pathname) ? pathname : '/home'
}

function renderRoute(pathname = currentPath()) {
  const route = currentPath(pathname)
  document.body.dataset.route = route.slice(1)
  window.__voiceSpaBoot = { phase: 'route-body-set', route }
  document.querySelectorAll('[data-route]').forEach((link) => {
    const href = link.getAttribute('href')
    if (href && new URL(href, window.location.href).pathname === route) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
  window.__voiceSpaBoot = { phase: 'route-links-set', route }
  app.innerHTML = routeTemplates[route]
  window.__voiceSpaBoot = { phase: 'route-template-set', route }
  document.title = `${routeTitles[route]} — Relay`
  window.__voiceSpaBoot = { phase: 'route-title-set', route }
  app.focus()
}

async function navigateSpa(href, source = 'voice tool') {
  const url = new URL(href, window.location.href)
  const route = currentPath(url.pathname)
  const currentQuery = window.location.search
  history.pushState({}, '', `${route}${url.search || currentQuery}`)
  renderRoute(route)
  trace('SPA navigation', `${source} → ${route}`)
  if (client.state.session) await client.updatePage({ url: window.location.href, title: document.title })
}

const tools = new SDK.ClientToolRegistry()
SDK.registerDomTools(tools, {
  capabilities: { pageContext: true, navigate: true, scroll: true, highlight: true },
  navigate: (href) => navigateSpa(href),
  authorize: ({ action, target }) => {
    trace(`Host authorized ${action}`, target ?? '')
    return true
  },
  highlightColor: '#ff5c35',
})
const mcpTools = await SDK.createMcpTools({
  async listTools() {
    return {
      tools: [{
        name: 'inventory.lookup',
        description: 'Read the public demo availability for one plan SKU.',
        inputSchema: {
          type: 'object',
          properties: { sku: { type: 'string', description: 'Plan SKU.' } },
          required: ['sku'],
          additionalProperties: false,
        },
      }],
    }
  },
  async callTool(request) {
    const response = await fetch('/api/mcp/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    if (!response.ok) throw new Error(`MCP demo transport failed: ${response.status}`)
    return response.json()
  },
}, {
  allow: ['inventory.lookup'],
  policy: { effect: 'read', consent: 'session', timeoutMs: 3_000 },
})
tools.registerMany(mcpTools)

const client = new SDK.ConvincedClient({
  orgSlug: 'voice-spa-demo',
  apiBase: window.location.origin,
  tools,
  authorizeToolCall: ({ tool, surface }) => {
    trace(`${surface} capability approved`, tool.name)
    return true
  },
})

client.on('ready', (state) => trace('Runtime ready', state.session?.sessionId ?? ''))
client.on('activity', (event) => trace('Chat activity', event.type))
client.on('client_tool_call', ({ call }) => trace('Chat requested tool', call.name))
client.on('client_tool_result', (result) => trace(`Chat tool ${result.ok ? 'completed' : 'failed'}`, result.name))
client.on('message', renderChatMessage)
client.on('error', (error) => trace('Runtime error', error.message))

function voiceEventValue(value, key, fallback) {
  if (typeof value === 'string') return value
  return value && typeof value === 'object' && typeof value[key] === 'string' ? value[key] : fallback
}

function setVoiceConnected(connected) {
  document.querySelector('#voice-dock').dataset.connected = String(connected)
  startButton.disabled = connected
  pricingButton.disabled = !connected
  proofButton.disabled = !connected
  inventoryButton.disabled = !connected
  muteButton.disabled = !connected
  endButton.disabled = !connected
}

function buildVoiceController() {
  const configuredAgentId = client.state.config?.elevenLabsAgentId
  const useReal = requestedRealVoice && typeof configuredAgentId === 'string' && configuredAgentId
  voiceModeBadge.textContent = useReal ? 'elevenlabs live' : requestedRealVoice ? 'mock · no agent id' : 'deterministic mock'
  const descriptor = {
    agentId: useReal ? configuredAgentId : 'mock-relay-agent',
    connectionType: 'webrtc',
    dynamicVariables: {
      session_id: client.state.session?.sessionId ?? '',
      campaign_token: client.state.session?.personalization?.agentMode === 'campaign' ? 'northstar-rollout' : 'organic',
      current_page: window.location.pathname,
    },
    exactClientTools: {
      host_navigate: 'host_navigate',
      host_get_page_context: 'host_get_page_context',
      host_scroll_to: 'host_scroll_to',
      host_highlight: 'host_highlight',
    },
  }

  return new SDK.ConvincedVoiceController({
    descriptor,
    tools,
    orgSlug: client.orgSlug,
    sessionId: client.state.session.sessionId,
    ...(useReal ? {} : {
      conversationFactory: createMockConversationFactory({
        firstMessage: client.state.session?.personalization?.firstMessage,
        onTrace: ({ kind, detail }) => trace(`ElevenLabs mock ${kind}`, JSON.stringify(detail)),
      }),
    }),
    authorizeToolCall: ({ tool }) => {
      trace('Voice capability approved', tool.name)
      return true
    },
    onStatusChange: (event) => {
      const status = voiceEventValue(event, 'status', 'unknown')
      voiceStatus.textContent = status === 'connected' ? 'Voice connected' : status
      trace('Voice status', status)
      setVoiceConnected(status === 'connected')
    },
    onModeChange: (event) => trace('Turn mode', voiceEventValue(event, 'mode', 'unknown')),
    onMessage: (event) => {
      const text = voiceEventValue(event, 'message', '')
      const source = voiceEventValue(event, 'source', 'voice')
      if (text) voiceCaption.textContent = `${source === 'user' ? 'You' : 'Guide'}: ${text}`
      trace(`Voice ${source}`, text)
    },
    onAudio: () => {
      window.__voiceSpaAudioChunks = (window.__voiceSpaAudioChunks ?? 0) + 1
      if (window.__voiceSpaAudioChunks === 1) trace('Voice audio received')
    },
    onConnect: () => {
      setVoiceConnected(true)
      trace('Voice transport connected')
    },
    onDisconnect: () => {
      setVoiceConnected(false)
      voiceStatus.textContent = 'Voice ended'
      trace('Voice transport disconnected')
    },
    onError: (error) => {
      voiceStatus.textContent = 'Voice error'
      trace('Voice error', error instanceof Error ? error.message : String(error))
    },
    onClientToolCall: ({ registryToolName, arguments: args }) => trace('Voice requested tool', `${registryToolName} ${JSON.stringify(args)}`),
    onClientToolResult: ({ registryToolName, result }) => trace(`Voice tool ${result.ok ? 'completed' : 'failed'}`, registryToolName),
    onConversationId: (conversationId) => {
      client.linkElevenLabsConversation(conversationId)
      trace('Conversation linked', conversationId)
    },
  })
}

startButton.addEventListener('click', async () => {
  try {
    await client.markVoiceUpgrade(client.state.messages.map(({ role, text: content }) => ({ role, content })))
    await voice.start()
  } catch (error) {
    trace('Unable to start voice', error instanceof Error ? error.message : String(error))
  }
})

pricingButton.addEventListener('click', () => voice.sendUserMessage('Open pricing and show me the enterprise plan.'))
proofButton.addEventListener('click', () => voice.sendUserMessage('Show me the customer proof case study.'))
inventoryButton.addEventListener('click', () => voice.sendUserMessage('Check enterprise inventory.'))
muteButton.addEventListener('click', () => {
  muted = !muted
  voice.setMuted(muted)
  muteButton.textContent = muted ? 'Unmute' : 'Mute'
})
endButton.addEventListener('click', async () => {
  try {
    await voice.end()
    await client.endSession()
    trace('Convinced session ended', client.state.session?.sessionId ?? '')
  } catch (error) {
    trace('Session end failed', error instanceof Error ? error.message : String(error))
  }
})
document.querySelector('#focus-voice').addEventListener('click', () => {
  document.querySelector('#voice-dock').scrollIntoView({ behavior: 'smooth', block: 'end' })
  startButton.focus()
})

document.querySelector('#chat-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const input = document.querySelector('#chat-input')
  const message = input.value.trim()
  if (!message) return
  input.value = ''
  await client.sendMessage(message)
})

document.querySelector('#clear-trace').addEventListener('click', () => traceList.replaceChildren())
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-route]')
  if (!link || event.defaultPrevented) return
  event.preventDefault()
  void navigateSpa(link.href, 'site navigation')
})
window.addEventListener('popstate', () => {
  renderRoute()
  void client.updatePage({ url: window.location.href, title: document.title })
})

function renderChatMessage(message) {
  const article = document.createElement('article')
  article.className = message.role
  article.textContent = message.text || '…'
  chatMessages.appendChild(article)
  chatMessages.scrollTop = chatMessages.scrollHeight
}

function renderAttribution() {
  const attribution = SDK.resolveWidgetSessionAttribution(initialUrl)
  document.querySelector('#campaign-token').textContent = attribution.c ?? 'organic'
  const details = document.querySelector('#campaign-details')
  const entries = [
    ['pid', attribution.pid],
    ['source', attribution.utmData?.utm_source],
    ['campaign', attribution.utmData?.utm_campaign],
  ].filter(([, value]) => value)
  details.innerHTML = entries.length
    ? entries.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')
    : '<div><dt>source</dt><dd>direct</dd></div>'
}

const routeTitles = { '/home': 'Product', '/pricing': 'Pricing', '/case-study': 'Customer proof' }
const routeTemplates = {
  '/home': `
    <section class="hero route-view">
      <div class="hero-kicker"><span>Voice-native product tours</span><b>01 / Product</b></div>
      <div class="hero-grid">
        <div><h1>Let the buyer<br><em>drive the demo.</em></h1><p>Relay turns live intent into a useful path through your product story. The voice guide can explain, navigate, scroll, and point—without taking control away from the visitor.</p></div>
        <div class="radar" id="home-demo-map" data-testid="home-demo-map"><i></i><i></i><i></i><span>LIVE<br>INTENT</span></div>
      </div>
      <div class="route-foot"><strong>Say “open pricing”</strong><span>The guide will change this SPA route without a reload.</span></div>
    </section>`,
  '/pricing': `
    <section class="pricing route-view">
      <div class="hero-kicker"><span>Transparent paths to value</span><b>02 / Pricing</b></div>
      <h1>Start useful.<br><em>Scale deliberate.</em></h1>
      <div class="price-grid">
        <article><small>Explore</small><h2>Signal</h2><strong>$0</strong><p>Prototype the buyer journey with chat and a bounded page context tool.</p><ul><li>One experience</li><li>Chat fallback</li><li>SDK trace</li></ul></article>
        <article><small>Launch</small><h2>Guide</h2><strong>$890<em>/mo</em></strong><p>Add ElevenLabs voice, media, identity, and host-page actions.</p><ul><li>Voice + chat</li><li>Slides and video</li><li>Campaign context</li></ul></article>
        <article id="pricing-enterprise" data-testid="pricing-enterprise"><small>Orchestrate</small><h2>Enterprise</h2><strong>Let’s design it</strong><p>Build custom agent behavior, MCP tools, rollout policy, and proof-led evaluations.</p><ul><li>Shared success plan</li><li>Governed client tools</li><li>Custom themes</li></ul><a href="/case-study" data-route>See the rollout proof →</a></article>
      </div>
    </section>`,
  '/case-study': `
    <section class="case-study route-view">
      <div class="hero-kicker"><span>Northstar Logistics</span><b>03 / Customer proof</b></div>
      <div class="case-layout">
        <div class="case-copy"><h1>Proof that<br><em>moves with intent.</em></h1><blockquote>“The guide stopped giving everyone the same tour. Buyers reached the right proof before our team joined.”</blockquote><p>Northstar connected Relay to a three-route product site. The agent learned when to explain, when to navigate, and when to let the evidence breathe.</p></div>
        <div class="metric" id="case-study-metric" data-testid="case-study-metric"><span>Time to first value</span><strong>−42%</strong><svg viewBox="0 0 320 130" aria-hidden="true"><path d="M6 112 C58 108, 62 82, 108 88 S158 55, 197 60 S258 24, 314 15"/></svg><small>Measured across 1,840 buyer sessions</small></div>
      </div>
      <div class="evidence-row"><span>1,840 sessions</span><span>3 live routes</span><span>4 governed tools</span><span>Voice primary</span></div>
    </section>`,
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character])
}

renderAttribution()
window.__voiceSpaBoot = { phase: 'attribution-rendered' }
renderRoute()
window.__voiceSpaBoot = { phase: 'route-rendered' }
window.__voiceSpaBoot = { phase: 'initializing' }
try {
  await client.initialize({ session: SDK.browserSessionInput({ url: initialUrl }) })
  voice = buildVoiceController()
  startButton.disabled = false
  document.querySelector('#voice-dock').dataset.ready = 'true'
  window.__voiceSpaBoot = { phase: 'ready' }
  trace('Voice adapter ready', requestedRealVoice ? 'real requested' : 'mock selected')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  window.__voiceSpaBoot = { phase: 'error', message }
  voiceStatus.textContent = 'Unable to initialize'
  trace('Initialization failed', message)
  console.error('Voice SPA example initialization failed:', error)
}

window.__voiceSpaDemo = {
  client,
  tools,
  get voice() { return voice },
  get trace() { return [...traceEntries] },
  navigate: navigateSpa,
}

import { createMockConversationFactory } from '/shared/mock-elevenlabs.js'

const SDK = window.ConvincedWidgetSDK
if (!SDK) throw new Error('Build the SDK before running this example.')

const traceList = document.querySelector('#trace-list')
const voiceStatus = document.querySelector('#voice-status')
const voiceCaption = document.querySelector('#voice-caption')
const voiceStart = document.querySelector('#voice-start')
const voiceProof = document.querySelector('#voice-proof')
const voiceEnd = document.querySelector('#voice-end')
const traceEntries = []
const requestedRealVoice = new URL(location.href).searchParams.get('voice') === 'real'
let voice = null
let widget = null

function trace(label, detail = '') {
  traceEntries.push({ at: new Date().toISOString(), label, detail })
  const item = document.createElement('li')
  item.textContent = `${label}${detail ? ` · ${detail}` : ''}`
  traceList.prepend(item)
  while (traceList.children.length > 7) traceList.lastElementChild?.remove()
}

async function navigateManaged(href) {
  const url = new URL(href, window.location.href)
  history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`)
  if (client.state.session) await client.updatePage({ url: window.location.href, title: document.title })
  trace('Page navigation', url.hash || url.pathname)
}

const tools = new SDK.ClientToolRegistry()
SDK.registerDomTools(tools, {
  capabilities: { pageContext: true, navigate: true, scroll: true, highlight: true },
  navigate: navigateManaged,
  authorize: ({ action, target }) => { trace(`Authorized ${action}`, target ?? ''); return true },
  highlightColor: '#c85b39',
})

const client = new SDK.ConvincedClient({
  orgSlug: 'managed-parity-demo', apiBase: window.location.origin, tools,
  authorizeToolCall: ({ tool, surface }) => { trace(`${surface} tool allowed`, tool.name); return true },
})

client.on('ready', () => trace('Default runtime ready', client.state.session?.sessionId ?? ''))
client.on('client_tool_call', ({ call }) => trace('Chat tool request', call.name))
client.on('client_tool_result', (result) => trace(`Chat tool ${result.ok ? 'done' : 'failed'}`, result.name))
client.on('identity', ({ input }) => trace('Identity captured', input.email))
client.on('error', (error) => trace('Runtime error', error.message))

await client.initialize({
  session: SDK.browserSessionInput({
    c: new URL(location.href).searchParams.get('c') ?? undefined,
  }),
})

const personalization = client.state.session.personalization
document.querySelector('#campaign-name').textContent = `${personalization?.agentMode ?? 'inbound'} · ${personalization?.targetCompany ?? 'general'}`
document.querySelector('#campaign-opener').textContent = personalization?.firstMessage ?? ''
const pills = document.querySelector('#campaign-pills')
for (const pill of client.state.config.pillsConfig?.pills ?? []) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = pill.label
  button.addEventListener('click', () => { widget?.open(); widget?.setMode('chat'); void client.sendMessage(pill.prompt) })
  pills.appendChild(button)
}

voice = new SDK.ConvincedVoiceController({
  descriptor: {
    agentId: requestedRealVoice && client.state.config.elevenLabsAgentId
      ? client.state.config.elevenLabsAgentId
      : 'mock-arcwell-agent',
    dynamicVariables: {
      session_id: client.state.session.sessionId,
      target_company: personalization?.targetCompany ?? 'visitor',
      campaign_mode: personalization?.agentMode ?? 'inbound',
    },
    exactClientTools: {
      host_navigate: 'host_navigate', host_get_page_context: 'host_get_page_context',
      host_scroll_to: 'host_scroll_to', host_highlight: 'host_highlight',
    },
  },
  tools, orgSlug: client.orgSlug, sessionId: () => client.state.session?.sessionId ?? null,
  ...(requestedRealVoice && client.state.config.elevenLabsAgentId ? {} : {
    conversationFactory: createMockConversationFactory({
      firstMessage: personalization?.firstMessage,
      destinations: {
        pricing: { url: '/#security', selector: '#security', color: '#175c52', reply: 'I opened the enterprise section, where governance and rollout policy are covered.' },
        proof: { url: '/#proof', selector: '#proof', color: '#c85b39', reply: 'Here is the Lumen proof: forty-six teams aligned and a twenty-eight percent shorter sales cycle.' },
        home: { url: '/#platform', selector: '#platform', reply: 'Here is the Arcwell signal map.' },
      },
      onTrace: ({ kind }) => trace('Voice transport', kind),
    }),
  }),
  authorizeToolCall: ({ tool }) => { trace('Voice tool allowed', tool.name); return true },
  onStatusChange: (state) => {
    voiceStatus.textContent = state.status === 'connected' ? 'Voice guide listening' : state.status
    const connected = state.status === 'connected'
    voiceStart.disabled = false; voiceProof.disabled = !connected; voiceEnd.disabled = !connected
    voiceStart.textContent = connected ? 'Hold to talk' : 'Hold to start talking'
    document.querySelector('#voice-bar').dataset.connected = String(connected)
    trace('Voice status', state.status)
  },
  onMessage: ({ source, message }) => { voiceCaption.textContent = `${source === 'user' ? 'You' : 'Maya'}: ${message}`; trace(`Voice ${source}`, message) },
  onAudio: () => {
    window.__managedParityAudioChunks = (window.__managedParityAudioChunks ?? 0) + 1
    if (window.__managedParityAudioChunks === 1) trace('Voice audio received')
  },
  onConversationId: (id) => { client.linkElevenLabsConversation(id); trace('Voice linked', id) },
  onClientToolCall: ({ registryToolName }) => trace('Voice tool request', registryToolName),
  onClientToolResult: ({ registryToolName, result }) => trace(`Voice tool ${result.ok ? 'done' : 'failed'}`, registryToolName),
  onError: (error) => trace('Voice error', error.message),
})

widget = SDK.mountConvincedWidget({
  client,
  voice,
  preset: 'managed-v2',
  target: '#default-widget-root',
  placement: 'floating',
  autoInitialize: false,
  openByDefault: false,
  launcherLabel: client.state.config.launcherCta,
  identityPolicy: ({ state, assistantMessages }) => {
    if (state.identity || assistantMessages < (state.config?.identityCaptureAfterExchanges ?? 1)) return false
    return {
      title: personalization?.targetCompany
        ? `Send me the ${personalization.targetCompany} rollout brief`
        : 'Send me the Arcwell rollout brief',
      description: 'Campaign mode can tailor the enquiry and timing.',
      submitLabel: 'Send brief',
      fields: ['email', 'name', 'company'],
    }
  },
})

voiceStart.disabled = false
document.querySelector('#start-managed-voice').disabled = false
document.querySelector('#voice-bar').dataset.ready = 'true'

async function beginVoice() {
  widget.open()
  widget.setMode('voice')
  widget.shadowRoot.querySelector('[data-voice-ptt]')?.focus()
  voiceStatus.textContent = 'Hold to start talking'
  voiceCaption.textContent = 'Voice connects from the first hold. The optional identity form appears after the third visitor turn.'
  trace('Managed voice ready', 'first-hold PTT')
}

function relayManagedPtt(type, sourceEvent) {
  if (type === 'pointerdown') void beginVoice()
  const ptt = widget.shadowRoot.querySelector('[data-voice-ptt]')
  if (!ptt) return
  ptt.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: sourceEvent.pointerId ?? 1,
    pointerType: sourceEvent.pointerType ?? 'mouse',
  }))
}

voiceStart.addEventListener('pointerdown', (event) => relayManagedPtt('pointerdown', event))
for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
  voiceStart.addEventListener(type, (event) => relayManagedPtt(type, event))
}
document.querySelector('#start-managed-voice').addEventListener('click', beginVoice)
voiceProof.addEventListener('click', () => voice.sendUserMessage('Show me the Lumen customer proof.'))
voiceEnd.addEventListener('click', async () => {
  await widget.endVoice()
  widget.close()
  trace('Session ended', client.state.session?.sessionId ?? '')
})
document.querySelector('#open-default-widget').addEventListener('click', () => widget.open())

window.__managedParityDemo = {
  client, tools, widget,
  get voice() { return voice },
  get voiceStartContext() {
    return SDK.buildManagedVoiceStartContext(client.state, {
      pageUrl: window.location.href,
      pageTitle: document.title,
      referrer: document.referrer,
    })
  },
  identityContract: { freeVisitorTurns: 2, softGateTurn: 3, hardGateTurn: 6 },
  get managedPtt() { return widget.shadowRoot.querySelector('[data-voice-ptt]') },
  get trace() { return [...traceEntries] },
}

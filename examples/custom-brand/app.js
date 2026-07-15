import { createMockConversationFactory } from '/shared/mock-elevenlabs.js'

const SDK = window.ConvincedWidgetSDK
if (!SDK) throw new Error('Build the SDK before running this example.')

const concierge = document.querySelector('#concierge')
const conversation = document.querySelector('#conversation')
const pillsContainer = document.querySelector('#campaign-pills')
const identityCard = document.querySelector('#identity-card')
const voiceState = document.querySelector('#voice-state')
const voiceCaption = document.querySelector('#voice-caption')
const startVoice = document.querySelector('#start-voice')
const voiceProof = document.querySelector('#voice-proof')
const endVoice = document.querySelector('#end-voice')
const traceList = document.querySelector('#trace-list')
const traceEntries = []
let voice = null
let identityWasOffered = false

function trace(label, detail = '') {
  traceEntries.push({ at: new Date().toISOString(), label, detail })
  const item = document.createElement('li')
  item.textContent = `${label}${detail ? ` · ${detail}` : ''}`
  traceList.prepend(item)
  while (traceList.children.length > 8) traceList.lastElementChild?.remove()
}

function openConcierge() {
  concierge.hidden = false
  requestAnimationFrame(() => concierge.dataset.open = 'true')
  startVoice.focus()
}

function closeConcierge() {
  concierge.dataset.open = 'false'
  setTimeout(() => { concierge.hidden = true }, 280)
}

async function navigateExperience(href) {
  const url = new URL(href, window.location.href)
  history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`)
  trace('Experience moved', url.hash || url.pathname)
  if (client.state.session) await client.updatePage({ url: window.location.href, title: document.title })
}

const tools = new SDK.ClientToolRegistry()
SDK.registerDomTools(tools, {
  capabilities: { pageContext: true, navigate: true, scroll: true, highlight: true },
  navigate: navigateExperience,
  authorize: ({ action, target }) => {
    trace(`Authorized ${action}`, target ?? '')
    return true
  },
  highlightColor: '#9f402b',
})

const client = new SDK.ConvincedClient({
  orgSlug: 'custom-brand-demo',
  apiBase: window.location.origin,
  tools,
  authorizeToolCall: ({ tool, surface }) => {
    trace(`${surface} tool allowed`, tool.name)
    return true
  },
})

client.on('state', renderConversation)
client.on('ready', () => trace('Campaign runtime ready', client.state.session?.sessionId ?? ''))
client.on('client_tool_call', ({ call }) => trace('Chat tool request', call.name))
client.on('client_tool_result', (result) => trace(`Chat tool ${result.ok ? 'done' : 'failed'}`, result.name))
client.on('identity', ({ input }) => trace('Lookbook requested', input.email))
client.on('error', (error) => trace('Runtime error', error.message))

function renderConversation(state) {
  conversation.replaceChildren()
  const firstMessage = state.session?.personalization?.firstMessage ?? state.config?.firstMessageText
  if (firstMessage) conversation.appendChild(messageElement('assistant', [{ type: 'text', text: firstMessage }]))
  for (const message of state.messages) {
    conversation.appendChild(messageElement(message.role, message.content))
  }
  conversation.scrollTop = conversation.scrollHeight

  const completedAssistantMessages = state.messages.filter((message) => message.role === 'assistant' && message.text).length
  if (completedAssistantMessages >= 1 && !state.identity && !identityWasOffered) {
    identityWasOffered = true
    identityCard.hidden = false
    trace('Custom identity enquiry shown', 'after first answered request')
  }
}

function messageElement(role, content) {
  const article = document.createElement('article')
  article.className = role
  for (const part of content) {
    if (part.type === 'text') {
      if (!part.text) continue
      const paragraph = document.createElement('p')
      paragraph.textContent = part.text
      article.appendChild(paragraph)
    } else if (part.type === 'slide') {
      const figure = document.createElement('figure')
      if (part.url) {
        const image = document.createElement('img')
        image.src = part.url
        image.alt = part.title ?? part.filename
        figure.appendChild(image)
      }
      const caption = document.createElement('figcaption')
      caption.textContent = part.title ?? part.filename
      figure.appendChild(caption)
      article.appendChild(figure)
    } else if (part.type === 'video') {
      const figure = document.createElement('figure')
      if (part.embedUrl) {
        const frame = document.createElement('iframe')
        frame.src = part.embedUrl
        frame.title = part.title ?? 'Campaign video'
        frame.allow = 'accelerometer; autoplay; encrypted-media; picture-in-picture'
        frame.allowFullscreen = true
        figure.appendChild(frame)
      } else {
        const link = document.createElement('a')
        link.href = part.url
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.textContent = `Open ${part.title ?? 'video'}`
        figure.appendChild(link)
      }
      const caption = document.createElement('figcaption')
      caption.textContent = part.title ?? 'Film'
      figure.appendChild(caption)
      article.appendChild(figure)
    }
  }
  if (!article.childNodes.length) article.textContent = '…'
  return article
}

async function sendMessage(message) {
  openConcierge()
  try { await client.sendMessage(message) } catch (error) { trace('Message failed', error instanceof Error ? error.message : String(error)) }
}

function renderCampaign() {
  const session = client.state.session
  const config = client.state.config
  const personalization = session?.personalization
  document.querySelector('#campaign-context').textContent = personalization?.targetCompany
    ? `Prepared for ${personalization.targetCompany}`
    : 'Private preview'
  pillsContainer.replaceChildren()
  for (const pill of config?.pillsConfig?.pills ?? []) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = pill.label
    button.style.setProperty('--pill-color', pill.color)
    button.addEventListener('click', () => void sendMessage(pill.prompt))
    pillsContainer.appendChild(button)
  }
}

function buildVoiceController() {
  return new SDK.ConvincedVoiceController({
    descriptor: {
      agentId: 'mock-morrow-agent',
      dynamicVariables: {
        session_id: client.state.session.sessionId,
        target_company: client.state.session.personalization?.targetCompany ?? 'private visitor',
        campaign_mode: client.state.session.personalization?.agentMode ?? 'inbound',
      },
      exactClientTools: {
        host_navigate: 'host_navigate',
        host_get_page_context: 'host_get_page_context',
        host_scroll_to: 'host_scroll_to',
        host_highlight: 'host_highlight',
      },
    },
    tools,
    orgSlug: client.orgSlug,
    sessionId: () => client.state.session?.sessionId ?? null,
    conversationFactory: createMockConversationFactory({
      firstMessage: client.state.session.personalization?.firstMessage,
      destinations: {
        pricing: {
          url: '/#commission', selector: '#commission', color: '#9f402b',
          reply: 'I have opened the private commission section. We begin with the room, the light, and what you want the piece to become over time.',
        },
        proof: {
          url: '/#proof-film', selector: '#proof-film', color: '#d1b88f',
          reply: 'This is Rosehip House. The room story and film are the strongest proof for the collection prepared for you.',
        },
        home: { url: '/#collection', selector: '#collection', reply: 'Here is the collection statement.' },
      },
      onTrace: ({ kind }) => trace('Voice transport', kind),
    }),
    authorizeToolCall: ({ tool }) => {
      trace('Voice tool allowed', tool.name)
      return true
    },
    onStatusChange: (state) => {
      voiceState.textContent = state.status === 'connected' ? 'Concierge listening' : state.status
      concierge.dataset.voice = state.status
      const connected = state.status === 'connected'
      startVoice.disabled = connected
      voiceProof.disabled = !connected
      endVoice.disabled = !connected
      trace('Voice status', state.status)
    },
    onMessage: ({ source, message }) => {
      voiceCaption.textContent = `${source === 'user' ? 'You' : 'Concierge'}: ${message}`
      trace(`Voice ${source}`, message)
    },
    onConversationId: (id) => { client.linkElevenLabsConversation(id); trace('Voice linked', id) },
    onClientToolCall: ({ registryToolName }) => trace('Voice tool request', registryToolName),
    onClientToolResult: ({ registryToolName, result }) => trace(`Voice tool ${result.ok ? 'done' : 'failed'}`, registryToolName),
    onError: (error) => trace('Voice error', error.message),
  })
}

document.querySelectorAll('#open-concierge, #show-concierge').forEach((button) => button.addEventListener('click', openConcierge))
document.querySelector('#close-concierge').addEventListener('click', closeConcierge)
document.querySelector('#ask-film').addEventListener('click', () => void sendMessage('Show me the Rosehip House film.'))
document.querySelector('#show-identity').addEventListener('click', () => { identityCard.hidden = false; identityCard.querySelector('input').focus() })

startVoice.addEventListener('click', async () => {
  openConcierge()
  await client.markVoiceUpgrade(client.state.messages.map(({ role, text: content }) => ({ role, content })))
  await voice.start()
})
voiceProof.addEventListener('click', () => voice.sendUserMessage('Show me the customer proof and room story.'))
endVoice.addEventListener('click', async () => {
  await voice.end()
  await client.endSession()
  trace('Session ended', client.state.session?.sessionId ?? '')
})

document.querySelector('#composer').addEventListener('submit', (event) => {
  event.preventDefault()
  const input = document.querySelector('#message')
  const message = input.value.trim()
  if (!message) return
  input.value = ''
  void sendMessage(message)
})

identityCard.addEventListener('submit', async (event) => {
  event.preventDefault()
  const data = new FormData(identityCard)
  await client.captureIdentity({ email: String(data.get('email') ?? ''), name: String(data.get('name') ?? '') })
  identityCard.innerHTML = '<strong>The lookbook is on its way.</strong><p>Identity was captured through the same SDK client, with a completely custom enquiry.</p>'
})

await client.initialize({ session: SDK.browserSessionInput() })
renderCampaign()
renderConversation(client.state)
voice = buildVoiceController()
startVoice.disabled = false
concierge.dataset.ready = 'true'
trace('Headless renderer mounted', 'voice + chat + media')

window.__customBrandDemo = {
  client,
  tools,
  get voice() { return voice },
  get trace() { return [...traceEntries] },
  open: openConcierge,
}

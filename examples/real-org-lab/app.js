const SDK = window.ConvincedWidgetSDK
const posthog = window.posthog
if (!SDK) throw new Error('Build the SDK before running the real organization lab.')

const runtime = await fetch('/api/runtime-config', { cache: 'no-store' }).then(async (response) => {
  if (!response.ok) throw new Error('Could not load the lab runtime configuration.')
  return response.json()
})

const allowedRoutes = new Set(['/overview', '/proof', '/security'])
const allowedSelectors = new Set(['#overview-orbit', '#proof-slide', '#security-controls'])
const demoPostHogEventNames = new Set(['widget.demo_opened', 'widget.demo_submitted', 'widget.demo_failed'])
const traceEntries = []
// before_send observes the SDK emission boundary. Warehouse ingestion is
// verified separately by the project E2E proxy/warehouse check.
const emittedDemoPostHogEvents = []
const PERSISTENT_DEMO_REQUEST_CONTEXT = 'Visitor opened the persistent demo request.'
let toolsAllowed = false
let analytics = null
let analyticsStarted = false
let voiceConnected = false
let sessionEnded = false
let linkedConversationId = null
let linkedVisitorId = null
let demoE2ERunning = false
let demoRequestState = {
  status: 'none',
  requestId: null,
  visitorId: null,
  submittedAt: null,
  identityLinked: false,
  alreadySubmitted: false,
}

const elements = {
  overallStatus: document.querySelector('#overall-status'),
  statusLight: document.querySelector('#status-light'),
  campaignStatus: document.querySelector('#campaign-status'),
  sessionStatus: document.querySelector('#session-status'),
  voiceStatus: document.querySelector('#voice-status'),
  posthogStatus: document.querySelector('#posthog-status'),
  identityStatus: document.querySelector('#identity-status'),
  demoRequestStatus: document.querySelector('#demo-request-status'),
  toolStatus: document.querySelector('#tool-status'),
  dashboardLink: document.querySelector('#dashboard-link'),
  replayLink: document.querySelector('#replay-link'),
  voiceCaption: document.querySelector('#voice-caption'),
  consentCard: document.querySelector('#consent-card'),
  consentError: document.querySelector('#consent-error'),
  beginTest: document.querySelector('#begin-test'),
  startVoice: document.querySelector('#start-voice'),
  endTest: document.querySelector('#end-test'),
  traceList: document.querySelector('#trace-list'),
  identityToggle: document.querySelector('#identity-toggle'),
  identityForm: document.querySelector('#identity-form'),
  identityResult: document.querySelector('#identity-result'),
  demoE2E: document.querySelector('#demo-e2e'),
  demoE2EResult: document.querySelector('#demo-e2e-result'),
  slideImage: document.querySelector('#proof-slide-image'),
  slideCaption: document.querySelector('#proof-slide-caption'),
}

function trace(label, detail = '') {
  const entry = { at: new Date().toISOString(), label, detail }
  traceEntries.push(entry)
  const item = document.createElement('li')
  item.textContent = `${new Date().toLocaleTimeString([], { hour12: false })} · ${label}${detail ? ` · ${detail}` : ''}`
  elements.traceList.prepend(item)
  while (elements.traceList.children.length > 12) elements.traceList.lastElementChild?.remove()
}

function safeRoute(pathname) {
  return allowedRoutes.has(pathname) ? pathname : '/overview'
}

function renderRoute(pathname = window.location.pathname) {
  const route = safeRoute(pathname)
  document.querySelectorAll('[data-page]').forEach((page) => {
    page.hidden = page.dataset.page !== route
  })
  document.querySelectorAll('[data-route]').forEach((link) => {
    const href = link.getAttribute('href')
    if (href && new URL(href, location.href).pathname === route) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
  const label = route === '/proof' ? 'Proof' : route === '/security' ? 'Security' : 'Overview'
  document.title = `${label} — Convinced Voice SDK Lab`
  return route
}

async function navigateSpa(href, source = 'page') {
  const target = new URL(href, window.location.href)
  if (target.origin !== window.location.origin || !allowedRoutes.has(target.pathname)) {
    throw new Error('The lab can navigate only to its three allowlisted routes.')
  }
  const currentCampaign = new URL(window.location.href).searchParams.get('c') || runtime.campaignToken
  const query = currentCampaign ? `?c=${encodeURIComponent(currentCampaign)}` : ''
  history.pushState({}, '', `${target.pathname}${query}`)
  const route = renderRoute(target.pathname)
  trace('SPA route', `${source} → ${route}`)
  if (client.state.session) {
    await client.updatePage({ url: window.location.href, title: document.title })
    voice?.sendContextualUpdate(`The visitor is now viewing the ${route.slice(1)} page.`, 'spa-route')
    if (analyticsStarted) {
      await analytics.capture('page_navigated', { route, source })
      capturePostHogPageView(route)
    }
  }
}

document.addEventListener('click', (event) => {
  const link = event.target.closest?.('[data-route]')
  if (!link) return
  event.preventDefault()
  void navigateSpa(link.getAttribute('href') || '/overview', 'visitor').catch((error) => {
    trace('Navigation rejected', error.message)
  })
})
window.addEventListener('popstate', () => {
  renderRoute()
  if (client?.state.session) void client.updatePage({ url: location.href, title: document.title })
})
renderRoute()

function initPostHog() {
  if (!runtime.posthogKey || !posthog?.init) {
    elements.posthogStatus.textContent = 'Not configured'
    return false
  }
  posthog.init(runtime.posthogKey, {
    api_host: runtime.posthogApiHost,
    ui_host: 'https://us.posthog.com',
    person_profiles: 'identified_only',
    capture_pageview: false,
    capture_pageleave: false,
    autocapture: false,
    capture_performance: false,
    disable_session_recording: true,
    opt_out_capturing_by_default: true,
    respect_dnt: true,
    session_recording: {
      maskAllInputs: true,
      blockClass: 'ph-no-capture',
      maskTextClass: 'ph-mask',
      recordHeaders: false,
      recordBody: false,
      maskCapturedNetworkRequestFn(request) {
        let name = request.name
        try {
          const url = new URL(request.name, window.location.origin)
          url.search = ''
          url.hash = ''
          name = url.toString()
        } catch {}
        return {
          ...request,
          name,
          requestHeaders: undefined,
          responseHeaders: undefined,
          requestBody: undefined,
          responseBody: undefined,
        }
      },
    },
    before_send(event) {
      const name = event?.event
      if (
        typeof name !== 'string' ||
        !(name.startsWith('widget.') || name === '$pageview' || name === '$snapshot' || name.startsWith('$session_recording'))
      ) return null
      if (demoPostHogEventNames.has(name)) emittedDemoPostHogEvents.push(name)
      const properties = { ...(event.properties || {}) }
      for (const key of ['$current_url', '$referrer', 'pageUrl']) {
        if (typeof properties[key] !== 'string') continue
        try {
          const url = new URL(properties[key], window.location.origin)
          url.search = ''
          url.hash = ''
          properties[key] = url.toString()
        } catch {
          delete properties[key]
        }
      }
      return { ...event, properties }
    },
  })
  return true
}

const posthogReady = initPostHog()

const tools = new SDK.ClientToolRegistry()
SDK.registerDomTools(tools, {
  capabilities: { pageContext: true, navigate: true, scroll: true, highlight: true },
  navigate: (href) => navigateSpa(href, 'voice tool'),
  authorize: ({ action, target }) => {
    const safeTarget = typeof target === 'string' ? target : ''
    const authorized = action === 'pageContext' || (
      toolsAllowed && (
        (action === 'navigate' && allowedRoutes.has(new URL(safeTarget, location.href).pathname)) ||
        ((action === 'scroll' || action === 'highlight') && allowedSelectors.has(safeTarget))
      )
    )
    trace(`DOM ${authorized ? 'allowed' : 'denied'}`, `${action}${safeTarget ? ` ${safeTarget}` : ''}`)
    return authorized
  },
  root: document,
  highlightColor: '#ff6945',
  highlightClass: 'convinced-highlight',
})

const mcpTools = await SDK.createMcpTools({
  async listTools() {
    return {
      tools: [{
        name: 'account.readiness',
        description: 'Read the approved Acme Robotics campaign readiness summary.',
        inputSchema: {
          type: 'object',
          properties: { account: { type: 'string', maxLength: 80 } },
          additionalProperties: false,
        },
      }],
    }
  },
  async callTool({ name }) {
    if (name !== 'account.readiness') throw new Error('Unknown MCP lab tool.')
    return {
      trust: 'approved_demo_observation',
      account: 'Acme Robotics',
      readiness: 'high',
      evidence: ['campaign research loaded', 'proof slide available', 'voice route bounded'],
    }
  },
}, {
  allow: ['account.readiness'],
  policy: { effect: 'read', consent: 'session', timeoutMs: 2_000 },
})
tools.registerMany(mcpTools)

const client = new SDK.ConvincedClient({
  orgSlug: runtime.orgSlug,
  apiBase: window.location.origin,
  tools,
  authorizeToolCall: ({ tool, surface }) => {
    const allowed = tool.effect === 'read' || toolsAllowed
    trace(`${surface} tool ${allowed ? 'authorized' : 'denied'}`, tool.name)
    return allowed
  },
})

client.on('ready', (state) => trace('Convinced session ready', shortId(state.session?.sessionId)))
client.on('client_tool_call', ({ call }) => {
  elements.toolStatus.textContent = `${call.name} · requested`
  trace('Chat tool requested', call.name)
  if (analyticsStarted) void analytics.capture('tool_requested', { toolName: call.name, surface: 'chat' })
})
client.on('client_tool_result', (result) => {
  elements.toolStatus.textContent = `${result.name} · ${result.ok ? 'complete' : 'failed'}`
  trace(`Chat tool ${result.ok ? 'complete' : 'failed'}`, result.name)
  if (analyticsStarted) void analytics.capture('tool_completed', { toolName: result.name, surface: 'chat', ok: result.ok })
})
client.on('identity', ({ response }) => {
  linkedVisitorId = response.visitorId
  elements.identityStatus.textContent = shortId(response.visitorId)
  elements.identityResult.textContent = `Linked ${shortId(response.visitorId)}`
  trace('Identity linked', shortId(response.visitorId))
})
client.on('demo_request', (event) => {
  if (event.status === 'opened') {
    demoRequestState = { ...demoRequestState, status: 'opened' }
    elements.demoRequestStatus.textContent = 'Open · no time booked'
    elements.demoRequestStatus.title = 'The request form is open. No calendar time has been scheduled.'
    trace('Demo request opened', event.surface || 'widget')
    return
  }
  if (event.status === 'submitted') {
    const requestId = safeOpaqueId(event.requestId)
    demoRequestState = {
      status: 'submitted',
      requestId: requestId || null,
      visitorId: safeOpaqueId(linkedVisitorId) || null,
      submittedAt: typeof event.submittedAt === 'string' ? event.submittedAt : null,
      identityLinked: event.identityLinked === true,
      alreadySubmitted: event.alreadySubmitted === true,
    }
    elements.demoRequestStatus.textContent = requestId
      ? `Received · ${shortId(requestId)}`
      : 'Received · follow-up pending'
    elements.demoRequestStatus.title = 'The request is stored for team follow-up. No calendar time has been scheduled.'
    elements.demoE2E.disabled = true
    trace('Demo request received', `${requestId ? `${shortId(requestId)} · ` : ''}follow-up pending, not booked`)
    return
  }
  demoRequestState = { ...demoRequestState, status: 'failed' }
  elements.demoRequestStatus.textContent = 'Failed · retry available'
  elements.demoRequestStatus.title = 'The request was not accepted and no calendar time was scheduled.'
  elements.demoE2E.disabled = !analyticsStarted || sessionEnded || demoE2ERunning
  trace('Demo request failed', `${event.stage === 'identity_sync' ? 'identity sync' : 'submission'} · ${event.errorCode}`)
})
client.on('error', (error) => trace('SDK error', error.message.slice(0, 120)))

await client.initialize({
  session: SDK.browserSessionInput({
    c: new URL(window.location.href).searchParams.get('c') || runtime.campaignToken,
  }),
  loadMedia: false,
})
await Promise.all([client.getSlides(), client.getSlideMetadata()])

const session = client.state.session
const personalization = session?.personalization
elements.sessionStatus.textContent = shortId(session?.sessionId)
elements.campaignStatus.textContent = personalization?.targetCompany
  ? `${personalization.agentMode} · ${personalization.targetCompany}`
  : personalization?.agentMode || 'inbound'
elements.dashboardLink.href = `${runtime.dashboardBase}/org/${encodeURIComponent(runtime.orgSlug)}/widget/sessions/${encodeURIComponent(session.sessionId)}`
elements.dashboardLink.setAttribute('aria-disabled', 'false')
trace('Campaign resolved', elements.campaignStatus.textContent)

const selectedSlide = client.state.slides.find((slide) => slide.filename === runtime.slideFilename)
const selectedMetadata = client.state.slideMetadata[runtime.slideFilename]
if (selectedSlide) {
  elements.slideImage.src = selectedSlide.url
  elements.slideImage.hidden = false
  document.querySelector('.slide-loading').hidden = true
  elements.slideCaption.textContent = selectedMetadata?.title || runtime.slideFilename
  trace('Real slide loaded', selectedMetadata?.title || runtime.slideFilename)
} else {
  document.querySelector('.slide-loading').textContent = 'The configured proof slide was not found.'
  trace('Slide missing', runtime.slideFilename)
}

const voice = new SDK.ConvincedVoiceController({
  descriptorFactory: async () => {
    const currentSession = client.state.session
    const capability = currentSession?.sessionCapability
    if (!currentSession?.sessionId) throw new Error('Convinced session is unavailable.')
    const response = await fetch('/api/voice-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(capability ? { 'x-widget-session-capability': capability } : {}),
      },
      body: '{}',
    })
    const descriptor = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(descriptor.error || 'Could not mint a private voice token.')
    return {
      ...descriptor,
      exactClientTools: {
        host_navigate: 'host_navigate',
        host_get_page_context: 'host_get_page_context',
        host_scroll_to: 'host_scroll_to',
        host_highlight: 'host_highlight',
      },
      genericClientTool: { name: 'host_extension_call' },
    }
  },
  tools,
  orgSlug: client.orgSlug,
  sessionId: () => client.state.session?.sessionId ?? null,
  authorizeToolCall: ({ tool }) => tool.effect === 'read' || toolsAllowed,
  onStatusChange: ({ status }) => {
    const wasVoiceConnected = voiceConnected
    voiceConnected = status === 'connected'
    elements.voiceStatus.textContent = status
    document.querySelectorAll('[data-voice-prompt]').forEach((button) => {
      button.disabled = !voiceConnected
    })
    trace('ElevenLabs status', status)
    if (voiceConnected && !wasVoiceConnected && analyticsStarted) {
      void analytics.capture('voice_started', { connectionType: 'webrtc' })
    }
  },
  onMessage: ({ source, message }) => {
    elements.voiceCaption.textContent = `${source === 'user' ? 'You' : 'Agent'}: ${message}`
    trace(`Voice ${source}`, `${message.length} characters`)
  },
  onAudio: () => {
    window.__realOrgLabAudioChunks = (window.__realOrgLabAudioChunks || 0) + 1
    if (window.__realOrgLabAudioChunks === 1) trace('ElevenLabs audio received')
  },
  onConversationId: (conversationId) => {
    linkedConversationId = conversationId
    client.linkElevenLabsConversation(conversationId)
    elements.voiceStatus.textContent = `linked · ${shortId(conversationId)}`
    trace('ElevenLabs linked', shortId(conversationId))
    if (analyticsStarted) void analytics.capture('voice_conversation_linked', {
      elevenLabsConversationId: conversationId,
    })
  },
  onClientToolCall: ({ registryToolName }) => {
    elements.toolStatus.textContent = `${registryToolName} · requested`
    trace('Voice tool requested', registryToolName)
    if (analyticsStarted) void analytics.capture('tool_requested', { toolName: registryToolName, surface: 'voice' })
  },
  onClientToolResult: ({ registryToolName, result }) => {
    elements.toolStatus.textContent = `${registryToolName} · ${result.ok ? 'complete' : 'failed'}`
    trace(`Voice tool ${result.ok ? 'complete' : 'failed'}`, registryToolName)
    if (analyticsStarted) void analytics.capture('tool_completed', {
      toolName: registryToolName,
      surface: 'voice',
      ok: result.ok,
    })
  },
  onError: (error) => {
    elements.voiceStatus.textContent = 'error'
    trace('Voice error', error.message.slice(0, 120))
  },
})

const widget = SDK.mountConvincedWidget({
  client,
  voice,
  preset: 'managed-v2',
  target: '#widget-root',
  placement: 'floating',
  autoInitialize: false,
  openByDefault: false,
  title: 'Convinced advisor',
  launcherLabel: 'Open the Convinced voice advisor',
  theme: {
    primary: '#ff7248',
    onPrimary: '#101915',
    accent: '#bdf5d8',
    background: '#0d1714',
    surface: '#17231f',
    text: '#f6f1e7',
    muted: '#a7b3ad',
    border: '#34443e',
    radius: '24px',
    fontFamily: '"Avenir Next", "Gill Sans", "Trebuchet MS", sans-serif',
    width: '420px',
    height: '660px',
    zIndex: 60,
  },
})

document.querySelector('#open-widget').addEventListener('click', () => widget.open())
elements.startVoice.addEventListener('click', () => {
  widget.open()
  widget.setMode('voice')
  widget.shadowRoot.querySelector('[data-voice-ptt]')?.focus()
  elements.voiceCaption.textContent = 'Hold the microphone button in the widget and speak your request.'
})

elements.beginTest.addEventListener('click', async () => {
  const analyticsConsent = document.querySelector('#analytics-consent').checked
  const toolConsent = document.querySelector('#tools-consent').checked
  if (!toolConsent) {
    elements.consentError.textContent = 'Allow the bounded demo page tools to run this test.'
    return
  }
  if (posthogReady && !analyticsConsent) {
    elements.consentError.textContent = 'Enable privacy-masked analytics to exercise the requested PostHog path.'
    return
  }
  elements.beginTest.disabled = true
  elements.consentError.textContent = ''
  toolsAllowed = true
  try {
    if (posthogReady) {
      posthog.opt_in_capturing()
      posthog.group?.('organization', runtime.orgSlug, { name: client.state.config?.orgName || runtime.orgSlug })
      analytics = SDK.createPostHogBridge({ client, posthog })
      const link = await analytics.start()
      analyticsStarted = true
      await analytics.capture('lab_started', {
        campaignMode: personalization?.agentMode || 'inbound',
        hasPersonalization: Boolean(personalization?.targetCompany),
      })
      updatePostHogLink(link)
      capturePostHogPageView(safeRoute(location.pathname))
      window.setTimeout(() => void refreshAnalyticsLink(), 2_000)
    } else {
      elements.posthogStatus.textContent = 'Not configured'
    }
    elements.consentCard.hidden = true
    elements.startVoice.disabled = !runtime.voiceAvailable
    elements.demoE2E.disabled = false
    elements.endTest.disabled = false
    elements.overallStatus.textContent = runtime.voiceAvailable ? 'Ready to test' : 'Tracking ready · voice unavailable'
    elements.statusLight.classList.add('ready')
    trace('Lab consent granted', posthogReady ? 'masked replay + bounded tools' : 'bounded tools')
  } catch (error) {
    elements.beginTest.disabled = false
    elements.consentError.textContent = error.message
    trace('Lab start failed', error.message.slice(0, 120))
  }
})

document.querySelectorAll('[data-voice-prompt]').forEach((button) => {
  button.addEventListener('click', () => {
    if (!voiceConnected) return
    voice.sendUserMessage(button.dataset.voicePrompt)
  })
})

elements.identityToggle.addEventListener('click', () => {
  const opening = elements.identityForm.hidden
  elements.identityForm.hidden = !opening
  elements.identityToggle.setAttribute('aria-expanded', String(opening))
})
elements.identityForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = new FormData(elements.identityForm)
  const input = {
    name: String(form.get('name') || '').trim(),
    email: String(form.get('email') || '').trim(),
    company: String(form.get('company') || '').trim(),
  }
  elements.identityResult.textContent = 'Saving…'
  try {
    const result = await client.captureIdentity(input)
    elements.identityResult.textContent = `Linked ${shortId(result.visitorId)}`
    if (analyticsStarted) {
      await analytics.capture('identity_linked', {
        hasName: Boolean(input.name),
        hasCompany: Boolean(input.company || result.derivedCompany),
      })
      await refreshAnalyticsLink()
    }
  } catch (error) {
    elements.identityResult.textContent = error.message
    trace('Identity failed', error.message.slice(0, 120))
  }
})

elements.demoE2E.addEventListener('click', () => {
  if (demoE2ERunning) return
  elements.demoE2E.disabled = true
  elements.demoE2EResult.textContent = 'Opening the real request form…'
  void runDemoRequestE2E().then((result) => {
    elements.demoE2EResult.textContent = `Passed · ${shortId(result.requestId)} · identity + durable replay + PostHog SDK emission`
  }).catch((error) => {
    elements.demoE2EResult.textContent = error.message
    trace('Demo request E2E failed', error.message.slice(0, 110))
  })
})

elements.endTest.addEventListener('click', async () => {
  if (sessionEnded) return
  sessionEnded = true
  elements.endTest.disabled = true
  elements.endTest.textContent = 'Persisting…'
  try {
    if (analyticsStarted) await analytics.capture('lab_ended', { hadVoice: Boolean(linkedConversationId) })
    await widget.endSession()
    await refreshAnalyticsLink()
    analytics?.stop()
    elements.overallStatus.textContent = 'Persisted · open dashboard'
    elements.endTest.textContent = 'Session persisted'
    trace('Session persisted', shortId(client.state.session?.sessionId))
  } catch (error) {
    sessionEnded = false
    elements.endTest.disabled = false
    elements.endTest.textContent = 'Retry session end'
    trace('Session end failed', error.message.slice(0, 120))
  }
})

async function refreshAnalyticsLink() {
  if (!analyticsStarted) return
  const link = await analytics.refreshLink()
  updatePostHogLink(link)
}

function updatePostHogLink(link) {
  elements.posthogStatus.textContent = link.posthogSessionId ? shortId(link.posthogSessionId) : 'Capturing'
  if (link.replayUrl) {
    elements.replayLink.href = link.replayUrl
    elements.replayLink.setAttribute('aria-disabled', 'false')
  }
}

function capturePostHogPageView(route) {
  if (!analyticsStarted) return
  posthog.capture('$pageview', {
    $current_url: `${window.location.origin}${route}`,
    convinced_session_id: client.state.session?.sessionId,
    convinced_org_slug: runtime.orgSlug,
  })
}

async function runDemoRequestE2E() {
  if (sessionEnded) throw new Error('Reload the page to create a fresh session before running this check.')
  if (!analyticsStarted) throw new Error('Start the consented lab test before running the PostHog check.')
  if (demoE2ERunning) throw new Error('The demo-request check is already running.')
  demoE2ERunning = true
  try {
    const suffix = `${Date.now().toString(36)}-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
    const values = {
      name: `SDK Demo E2E ${suffix}`,
      email: `sdk-demo-e2e+${suffix}@getconvinced.ai`,
      company: 'Convinced SDK QA',
      phone: '',
    }

    widget.open()
    const cta = await waitUntilValue(() => {
      const candidate = widget.shadowRoot.querySelector('[data-demo-request-cta]')
      return candidate && !candidate.hidden ? candidate : null
    }, 3_000, 'The organization does not expose the in-widget demo-request fallback.')

    const opened = waitForDemoStatus('opened', 3_000)
    cta.click()
    await opened

    const form = await waitUntilValue(
      () => widget.shadowRoot.querySelector('[data-demo-request-form]'),
      3_000,
      'The demo-request form did not open.',
    )
    for (const [field, value] of Object.entries(values)) {
      const input = form.querySelector(`[name="${field}"]`)
      if (!input) continue
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }

    elements.demoE2EResult.textContent = 'Submitting a unique masked QA identity…'
    const submitted = waitForDemoStatus('submitted', 15_000)
    form.requestSubmit()
    const event = await submitted
    if (event.alreadySubmitted) {
      throw new Error('This session already contains a demo request. Reload for a fresh E2E session.')
    }

    const requestId = safeOpaqueId(event.requestId)
    const visitorId = safeOpaqueId(linkedVisitorId)
    if (!requestId || !visitorId || event.identityLinked !== true) {
      throw new Error('The backend accepted the request without complete request/identity correlation.')
    }
    if (client.state.identity?.email?.trim().toLowerCase() !== values.email) {
      throw new Error('The SDK identity state did not link to the submitted request identity.')
    }

    elements.demoE2EResult.textContent = 'Verifying the durable idempotency record…'
    const replay = await replayDemoRequest({
      ...values,
      context: PERSISTENT_DEMO_REQUEST_CONTEXT,
    })
    if (
      replay?.ok !== true ||
      replay?.alreadySubmitted !== true ||
      safeOpaqueId(replay.requestId) !== requestId ||
      safeOpaqueId(replay.visitorId) !== visitorId
    ) {
      throw new Error('The backend did not return matching durable replay evidence.')
    }

    await waitUntilValue(
      () => emittedDemoPostHogEvents.includes('widget.demo_opened') &&
        emittedDemoPostHogEvents.includes('widget.demo_submitted'),
      3_000,
      'The PostHog SDK bridge did not emit the consented demo lifecycle events.',
    )
    trace('Demo request E2E passed', `${shortId(requestId)} · durable + identity + PostHog SDK emission`)
    return {
      ok: true,
      requestId,
      visitorId,
      submittedAt: typeof event.submittedAt === 'string' ? event.submittedAt : null,
      identityLinked: true,
      durableReplay: true,
      posthogEmittedEvents: ['widget.demo_opened', 'widget.demo_submitted'],
    }
  } finally {
    demoE2ERunning = false
    elements.demoE2E.disabled = sessionEnded || demoRequestState.status === 'submitted'
  }
}

async function replayDemoRequest(values) {
  const session = client.state.session
  if (!session?.sessionId || !session.sessionCapability) {
    throw new Error('The signed session capability is unavailable for the durability check.')
  }
  const response = await fetch(`/api/widget/${encodeURIComponent(runtime.orgSlug)}/demo-request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-widget-session-capability': session.sessionCapability,
    },
    body: JSON.stringify({
      sessionId: session.sessionId,
      ...values,
    }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `Durability replay failed (${response.status}).`)
  return body
}

function waitForDemoStatus(successStatus, timeoutMs) {
  return new Promise((resolve, reject) => {
    let remove = () => undefined
    const timeout = window.setTimeout(() => {
      remove()
      reject(new Error(`Demo request status ${successStatus} was not emitted within ${timeoutMs}ms.`))
    }, timeoutMs)
    const settle = (callback, value) => {
      window.clearTimeout(timeout)
      remove()
      callback(value)
    }
    remove = client.on('demo_request', (event) => {
      if (event.status === successStatus) settle(resolve, event)
      else if (event.status === 'failed') settle(reject, new Error(`Demo request failed (${event.errorCode}).`))
    })
  })
}

async function waitUntilValue(read, timeoutMs, message) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = read()
    if (value) return value
    await new Promise(resolve => window.setTimeout(resolve, 25))
  }
  throw new Error(message)
}

function safeOpaqueId(value) {
  if (typeof value !== 'string') return ''
  const id = value.trim()
  return /^[A-Za-z0-9_-]{1,256}$/.test(id) ? id : ''
}

function shortId(value) {
  if (!value) return '—'
  const safe = String(value)
  return safe.length <= 18 ? safe : `${safe.slice(0, 8)}…${safe.slice(-6)}`
}

elements.overallStatus.textContent = 'Session ready · consent required'
elements.statusLight.classList.add('ready')
if (!runtime.voiceAvailable) {
  elements.voiceStatus.textContent = 'Private test agent not configured'
  elements.startVoice.title = 'Set SAMPLE_ELEVENLABS_AGENT_ID and ELEVEN_API_KEY on the local lab server.'
}

window.__realOrgLab = {
  client,
  voice,
  widget,
  tools,
  runtime,
  navigateSpa,
  get analytics() { return analytics },
  get analyticsStarted() { return analyticsStarted },
  get linkedConversationId() { return linkedConversationId },
  get linkedVisitorId() { return linkedVisitorId },
  get demoRequest() { return { ...demoRequestState } },
  get demoPostHogEmittedEvents() { return [...emittedDemoPostHogEvents] },
  get trace() { return [...traceEntries] },
  runDemoRequestE2E,
  get state() {
    return {
      toolsAllowed,
      voiceConnected,
      sessionEnded,
      posthogLink: analytics?.link || null,
      audioChunks: window.__realOrgLabAudioChunks || 0,
    }
  },
}

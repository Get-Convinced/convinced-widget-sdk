import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import {
  ClientToolRegistry,
  ConvincedClient,
  ConvincedVoiceController,
  mountConvincedWidget,
  type ElevenLabsStartSessionOptions,
  type JsonObject,
} from '../src'
import { managedWidgetInlineStyleText } from '../src/widget'

describe('default Shadow DOM widget', () => {
  let restoreDom: (() => void) | undefined

  beforeEach(() => {
    restoreDom = installDom()
  })

  afterEach(() => {
    restoreDom?.()
  })

  test('keeps legacy accent themes readable while allowing an explicit primary foreground', () => {
    const css = managedWidgetInlineStyleText()
    expect(css).toContain('--convinced-primary: #c24c2e;')
    expect(css).toContain('--convinced-on-primary: var(--convinced-accent);')
    expect(css).toContain('--convinced-expand-glow: #0f766e;')
  })

  test('renders an accessible soft profile gate without locking chat', async () => {
    const client = await widgetClient({ disableInput: false })
    const widget = mountConvincedWidget({
      client,
      target: '#widget',
      placement: 'inline',
      autoInitialize: false,
    })

    await client.sendMessage('Show me the robot')
    const panel = required(widget.shadowRoot, '[data-panel]')
    const composer = required(widget.shadowRoot, '[data-composer]') as HTMLTextAreaElement
    const identity = required(widget.shadowRoot, '[data-identity]')

    expect(panel.getAttribute('role')).toBe('region')
    expect(required(widget.shadowRoot, '[data-messages]').getAttribute('role')).toBe('log')
    expect(identity.textContent).toContain('Tell us where to follow up')
    expect(identity.querySelector('input[name="email"]')).not.toBeNull()
    expect(composer.disabled).toBe(false)
    widget.destroy()
  })

  test('customizes a hard identity gate and unlocks only after capture', async () => {
    const identityBodies: JsonObject[] = []
    const client = await widgetClient({ disableInput: true, identityBodies })
    const widget = mountConvincedWidget({
      client,
      target: '#widget',
      placement: 'inline',
      autoInitialize: false,
      theme: { primary: '#0f766e', onPrimary: '#fffdf7', accent: '#bdf5d8', radius: '10px' },
      identityPolicy: () => ({
        title: 'Get the warehouse plan',
        description: 'Where should we send the tailored rollout?',
        submitLabel: 'Send my plan',
        fields: ['phone'],
      }),
    })

    await client.sendMessage('Build a rollout')
    await Promise.resolve()
    const composer = required(widget.shadowRoot, '[data-composer]') as HTMLTextAreaElement
    let form = required(widget.shadowRoot, '.identity-form') as HTMLFormElement
    expect(widget.host.style.getPropertyValue('--convinced-primary')).toBe('#0f766e')
    expect(widget.host.style.getPropertyValue('--convinced-on-primary')).toBe('#fffdf7')
    expect(widget.host.style.getPropertyValue('--convinced-accent')).toBe('#bdf5d8')
    expect(form.textContent).toContain('Get the warehouse plan')
    expect(form.querySelector('input[name="email"]')).not.toBeNull()
    expect(form.querySelector('input[name="phone"]')).not.toBeNull()
    expect(composer.disabled).toBe(true)

    let email = form.querySelector('input[name="email"]') as unknown as HTMLInputElement
    let phone = form.querySelector('input[name="phone"]') as unknown as HTMLInputElement
    email.value = 'buyer@gmail.com'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Bun.sleep(0)
    expect(client.state.identity).toBeNull()
    expect(required(widget.shadowRoot, '[data-error]').textContent).toContain('business email')
    form = required(widget.shadowRoot, '.identity-form') as HTMLFormElement
    email = required(widget.shadowRoot, 'input[name="email"]') as unknown as HTMLInputElement
    phone = required(widget.shadowRoot, 'input[name="phone"]') as unknown as HTMLInputElement
    email.value = 'buyer@example.com'
    phone.value = '+1 555 0100'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await waitFor(() => client.state.identity?.email === 'buyer@example.com')

    expect(identityBodies).toEqual([
      expect.objectContaining({
        sessionId: 'session_widget',
        email: 'buyer@example.com',
        phone: '+1 555 0100',
      }),
    ])
    expect(composer.disabled).toBe(false)
    expect(required(widget.shadowRoot, '[data-identity]').hasAttribute('hidden')).toBe(true)
    widget.destroy()
  })

  test('renders an async identity policy failure without an unhandled rejection', async () => {
    const client = await widgetClient({ disableInput: false })
    const widget = mountConvincedWidget({
      client,
      target: '#widget',
      placement: 'inline',
      autoInitialize: false,
      identityPolicy: async () => {
        throw new Error('Identity policy unavailable')
      },
    })

    await client.sendMessage('Trigger policy')
    await waitFor(() => required(widget.shadowRoot, '[data-error]').textContent?.includes('unavailable') === true)

    const error = required(widget.shadowRoot, '[data-error]')
    expect(error.hasAttribute('hidden')).toBe(false)
    expect(error.textContent).toContain('Identity policy unavailable')
    widget.destroy()
  })

  test('renders the managed voice-first campaign experience and controls ElevenLabs lifecycle', async () => {
    const contextBodies: JsonObject[] = []
    const endBodies: JsonObject[] = []
    const chatBodies: JsonObject[] = []
    const identityBodies: JsonObject[] = []
    const demoRequestBodies: JsonObject[] = []
    const demoRequestLifecycle: unknown[] = []
    const visitorIntelCapabilities: string[] = []
    let capturedVoiceOptions!: ElevenLabsStartSessionOptions
    let endCalls = 0
    const micMuted: boolean[] = []
    const volume: number[] = []
    const contextualUpdates: string[] = []
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          return Response.json({
            sessionId: 'session_voice_widget',
            sessionCapability: 'capability_voice_widget',
            knowledgeKit: 'Approved warehouse automation context.',
            recommendedSlides: [{
              filename: 'warehouse-roi.svg',
              title: 'Warehouse ROI',
              slideType: 'proof',
              score: 0.98,
            }, {
              filename: 'metadata-only.svg',
              title: 'Unavailable metadata-only proof',
              slideType: 'proof',
              score: 0.5,
            }],
            recommendedVideos: [{
              title: 'Warehouse tour',
              url: 'https://www.youtube.com/watch?v=abcdefghijk',
              sourceType: 'youtube_video',
            }],
            personalization: {
              targetCompany: 'Acme',
              targetPerson: 'Voice Buyer',
              targetRole: 'VP Operations',
              targetIndustry: 'Warehousing',
              agentMode: 'campaign',
              promptAdditions: 'Acme may be evaluating warehouse automation.',
              firstMessage: 'Welcome to Acme’s voice-first warehouse demo.',
              knowledgeKit: 'Campaign-specific approved context.',
              recommendedSlides: [],
              talkTrack: ['Validate the current warehouse workflow.'],
              challenges: ['Manual dispatch handoffs'],
              caseStudies: [],
            },
            config: {
              orgName: 'Robot Store',
              orgSlug: 'demo',
              voiceEnabled: true,
              voiceMode: 'always_voice',
              allowModeToggle: true,
              slidesEnabled: true,
              firstMessageEnabled: true,
              firstMessageText: 'Welcome to the voice-first warehouse demo.',
              pillsConfig: {
                enabled: true,
                warmupExchanges: 1,
                emailGateMessage: 'Share email',
                pills: [
                  { id: 'second', label: 'See ROI', color: '#fff', productName: null, prompt: 'Show ROI', order: 2 },
                  { id: 'first', label: 'Tour automation', color: '#fff', productName: null, prompt: 'Tour automation', order: 1 },
                ],
              },
              suggestedQuestions: ['How fast is rollout?', 'Show integrations'],
            },
          })
        }
        if (url.pathname.endsWith('/context')) {
          contextBodies.push(JSON.parse(String(init.body)) as JsonObject)
          return Response.json({ ok: true })
        }
        if (url.pathname.endsWith('/slides/metadata')) {
          return Response.json({
            slides: [{
              filename: 'warehouse-roi.svg',
              title: 'Warehouse ROI',
              description: 'Approved warehouse return proof.',
              keyPoints: ['28% faster'],
            }],
          })
        }
        if (url.pathname.endsWith('/slides')) {
          return Response.json({
            slides: [{
              key: 'slides/warehouse-roi.svg',
              filename: 'warehouse-roi.svg',
              url: 'https://cdn.example.com/warehouse-roi.svg',
            }],
          })
        }
        if (url.pathname.endsWith('/identity')) {
          identityBodies.push(JSON.parse(String(init.body)) as JsonObject)
          return Response.json({ visitorId: 'visitor_voice_widget' })
        }
        if (url.pathname.endsWith('/visitor-intel')) {
          visitorIntelCapabilities.push(new Headers(init.headers).get('x-widget-session-capability') ?? '')
          return Response.json({
            status: 'ready',
            companyName: 'Acme',
            summary: 'Acme operates multi-site warehouse automation.',
            sources: [{ title: 'Acme profile', url: 'https://acme.example/about' }],
          })
        }
        if (url.pathname.endsWith('/demo-request')) {
          demoRequestBodies.push(JSON.parse(String(init.body)) as JsonObject)
          expect(new Headers(init.headers).get('x-widget-session-capability')).toBe('capability_voice_widget')
          if (demoRequestBodies.length === 1) {
            return Response.json({
              error: 'Demo delivery is temporarily unavailable.',
              code: 'demo_delivery_unavailable',
            }, { status: 503 })
          }
          return Response.json({
            ok: true,
            submittedAt: '2026-07-15T00:00:00.000Z',
            visitorId: 'visitor_voice_widget',
          })
        }
        if (url.pathname.endsWith('/chat')) {
          chatBodies.push(JSON.parse(String(init.body)) as JsonObject)
          return sse([{ delta: 'Continuing the same conversation in chat. [SLIDE:warehouse-roi.svg] [VIDEO:https://www.youtube.com/watch?v=abcdefghijk|Warehouse tour]' }])
        }
        if (url.pathname.endsWith('/session/end')) {
          endBodies.push(JSON.parse(String(init.body)) as JsonObject)
          return Response.json({ ok: true })
        }
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession()
    client.on('demo_request', (event) => demoRequestLifecycle.push(event))
    await Promise.all([client.getSlides(), client.getSlideMetadata()])
    const voice = new ConvincedVoiceController({
      descriptor: { agentId: 'agent_widget', genericClientTool: false },
      tools: new ClientToolRegistry(),
      orgSlug: 'demo',
      sessionId: () => client.state.session?.sessionId ?? null,
      conversationFactory: async (options) => {
        capturedVoiceOptions = options
        options.onConnect?.({ conversationId: 'conv_widget_123' })
        return {
          async endSession() { endCalls += 1 },
          getId: () => 'conv_widget_123',
          setMicMuted: (muted) => { micMuted.push(muted) },
          setVolume: ({ volume: nextVolume }) => { volume.push(nextVolume) },
          sendContextualUpdate(text) { contextualUpdates.push(text) },
          sendUserMessage() {},
          sendUserActivity() {},
        }
      },
    })
    const widget = mountConvincedWidget({
      client,
      voice,
      target: '#widget',
      placement: 'inline',
      autoInitialize: false,
    })

    expect(widget.host.dataset.preset).toBe('managed-v2')
    expect(widget.host.dataset.mode).toBe('voice')
    expect(required(widget.shadowRoot, '[data-voice-panel]').hasAttribute('hidden')).toBe(false)
    expect(required(widget.shadowRoot, '[data-chat-form]').hasAttribute('hidden')).toBe(true)
    expect(required(widget.shadowRoot, '[data-mode-switch]').hasAttribute('hidden')).toBe(false)
    expect(required(widget.shadowRoot, '[data-messages]').textContent)
      .toContain('Welcome to Acme’s voice-first warehouse demo.')
    const prompts = Array.from(widget.shadowRoot.querySelectorAll<HTMLButtonElement>('[data-suggestions] button'))
    expect(prompts.map((button) => button.textContent)).toEqual([
      'Tour automation',
      'See ROI',
      'How fast is rollout?',
      'Show integrations',
    ])
    expect(prompts.map((button) => button.dataset.kind)).toEqual([
      'campaign', 'campaign', 'suggested', 'suggested',
    ])

    const demoRequestCta = required(widget.shadowRoot, '[data-demo-request-cta]')
    expect(demoRequestCta.hasAttribute('hidden')).toBe(false)

    required(widget.shadowRoot, '[data-mode-chat]').dispatchEvent(new Event('click', { bubbles: true }))
    expect(widget.host.dataset.mode).toBe('chat')
    expect(required(widget.shadowRoot, '[data-chat-form]').hasAttribute('hidden')).toBe(false)
    required(widget.shadowRoot, '[data-mode-voice]').dispatchEvent(new Event('click', { bubbles: true }))
    expect(widget.host.dataset.mode).toBe('voice')

    expect(await widget.startVoice()).toBe('started')
    expect(voice.state.status).toBe('connected')
    expect(widget.shadowRoot.querySelector('.identity-form')).toBeNull()
    expect(capturedVoiceOptions.dynamicVariables).toMatchObject({
      SESSION_ID: 'session_voice_widget',
      IDENTITY_CONFIRMED: 'false',
    })
    expect(capturedVoiceOptions.dynamicVariables?.KNOWLEDGE_KIT).toContain('Campaign-specific approved context')
    expect(capturedVoiceOptions.dynamicVariables?.OUTREACH_CONTEXT).toContain('Target company: Acme')
    expect(capturedVoiceOptions.overrides).toMatchObject({
      agent: { firstMessage: 'Welcome to Acme’s voice-first warehouse demo.' },
    })
    expect(Object.keys(capturedVoiceOptions.clientTools)).toEqual(expect.arrayContaining([
      'show_slide',
      'show_youtube_embed',
      'set_visitor_field',
      'request_email_capture',
      'show_book_demo_cta',
      'confirm_visitor_form',
    ]))
    capturedVoiceOptions.onMessage?.({ message: 'First visitor utterance.', source: 'user', role: 'user' })
    capturedVoiceOptions.onMessage?.({ message: 'Second visitor utterance.', source: 'user', role: 'user' })
    expect(widget.shadowRoot.querySelector('.identity-form')).toBeNull()
    capturedVoiceOptions.onMessage?.({ message: 'Third visitor utterance.', source: 'user', role: 'user' })
    const voiceIdentityForm = required(widget.shadowRoot, '.identity-form') as HTMLFormElement
    expect(voiceIdentityForm.querySelector('input[name="phone"]')).not.toBeNull()
    expect(voiceIdentityForm.querySelector('input[name="role"]')).toBeNull()
    const modelSuppliedCapture = JSON.parse(String(
      await capturedVoiceOptions.clientTools.request_email_capture?.({
        email: 'hallucinated@example.com',
        name: 'Model Supplied',
        company: 'Unconfirmed Company',
        resourceType: 'case_study',
        resourceLabel: 'Warehouse proof',
        reason: 'Send a follow-up',
      }),
    ))
    expect(modelSuppliedCapture).toMatchObject({
      trust: 'untrusted_tool_observation',
      observation: {
        result: {
          status: 'displayed',
          requiresConfirmation: true,
          prefilledFields: [],
          resourceType: 'case_study',
          resourceLabel: 'Warehouse proof',
        },
      },
    })
    expect(client.state.identity).toBeNull()
    expect(identityBodies).toHaveLength(0)
    expect((required(widget.shadowRoot, 'input[name="email"]') as unknown as HTMLInputElement).value)
      .toBe('')
    capturedVoiceOptions.onMessage?.({ message: 'Fourth visitor utterance.', source: 'user', role: 'user' })
    capturedVoiceOptions.onMessage?.({ message: 'Fifth visitor utterance.', source: 'user', role: 'user' })
    capturedVoiceOptions.onMessage?.({ message: 'Sixth visitor utterance.', source: 'user', role: 'user' })
    expect(contextualUpdates.some((update) => update.includes('HARD GATE'))).toBe(true)
    const personalEmailResult = JSON.parse(String(
      await capturedVoiceOptions.clientTools.set_visitor_field?.({ field: 'email', value: 'voice@gmail.com' }),
    ))
    expect(personalEmailResult).toMatchObject({
      trust: 'untrusted_tool_observation',
      observation: { result: { status: 'rejected', reason: 'invalid_value', field: 'email' } },
    })
    await capturedVoiceOptions.clientTools.set_visitor_field?.({ field: 'email', value: 'VOICE@EXAMPLE.COM' })
    await capturedVoiceOptions.clientTools.set_visitor_field?.({ field: 'name', value: 'Voice Buyer' })
    await capturedVoiceOptions.clientTools.set_visitor_field?.({ field: 'company', value: 'Acme' })
    const modelConfirmation = JSON.parse(String(
      await capturedVoiceOptions.clientTools.confirm_visitor_form?.({}),
    ))
    expect(modelConfirmation).toMatchObject({
      trust: 'untrusted_tool_observation',
      observation: {
        ok: false,
        error: { code: 'consent_denied' },
      },
    })
    expect(client.state.identity).toBeNull()
    expect(identityBodies).toHaveLength(0)

    const visitorConfirmationForm = required(widget.shadowRoot, '.identity-form') as HTMLFormElement
    visitorConfirmationForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await waitFor(() => client.state.identity?.email === 'voice@example.com')
    expect(identityBodies).toEqual([
      expect.objectContaining({
        email: 'voice@example.com',
        name: 'Voice Buyer',
        company: 'Acme',
        resourceType: 'case_study',
        resourceLabel: 'Warehouse proof',
      }),
    ])
    expect(contextualUpdates.some((update) => update.includes('IDENTITY_CONFIRMED'))).toBe(true)
    await waitFor(() => contextualUpdates.some((update) => update.includes('VISITOR_CONTEXT enriched')))
    expect(contextualUpdates.find((update) => update.includes('VISITOR_CONTEXT enriched')))
      .toContain('Acme operates multi-site warehouse automation.')
    expect(visitorIntelCapabilities).toEqual(['capability_voice_widget'])

    const identityUpdatesBeforeDemo = contextualUpdates.filter(
      (update) => update.includes('[IDENTITY_CONFIRMED]'),
    ).length
    demoRequestCta.dispatchEvent(new Event('click', { bubbles: true }))
    const demoForm = required(widget.shadowRoot, '[data-demo-request-form]') as HTMLFormElement
    expect((required(demoForm, 'input[name="name"]') as HTMLInputElement).value).toBe('Voice Buyer')
    expect((required(demoForm, 'input[name="email"]') as HTMLInputElement).value).toBe('voice@example.com')
    demoForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await waitFor(() => demoRequestBodies.length === 1)
    await waitFor(() => required(widget.shadowRoot, '[data-demo-request]').textContent?.includes('temporarily unavailable') === true)
    const retryForm = required(widget.shadowRoot, '[data-demo-request-form]') as HTMLFormElement
    expect((required(retryForm, 'input[name="name"]') as HTMLInputElement).value).toBe('Voice Buyer')
    expect((required(retryForm, 'input[name="email"]') as HTMLInputElement).value).toBe('voice@example.com')
    retryForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await waitFor(() => demoRequestBodies.length === 2)
    expect(demoRequestBodies[1]).toMatchObject({
      sessionId: 'session_voice_widget',
      name: 'Voice Buyer',
      email: 'voice@example.com',
      company: 'Acme',
    })
    await waitFor(() => required(widget.shadowRoot, '[data-demo-request]').textContent?.includes('has been sent') === true)
    expect(required(widget.shadowRoot, '[data-demo-request]').textContent).toContain('has been sent')
    expect(identityBodies).toHaveLength(1)
    await waitFor(() => contextualUpdates.filter(
      (update) => update.includes('[IDENTITY_CONFIRMED]'),
    ).length === identityUpdatesBeforeDemo + 1)
    const demoIdentityUpdate = contextualUpdates.filter(
      (update) => update.includes('[IDENTITY_CONFIRMED]'),
    ).at(-1)
    expect(demoIdentityUpdate).toBe(
      '[IDENTITY_CONFIRMED]\nThe visitor confirmed their details through the demo request form. Continue the existing thread without restarting discovery.',
    )
    expect(demoIdentityUpdate).not.toContain('Voice Buyer')
    expect(demoIdentityUpdate).not.toContain('voice@example.com')
    await waitFor(() => visitorIntelCapabilities.length === 2)
    const demoToolResult = JSON.parse(String(
      await capturedVoiceOptions.clientTools.show_book_demo_cta?.({ reason: 'Agent offered a demo.' }),
    ))
    expect(demoToolResult).toMatchObject({
      observation: { result: { status: 'form_displayed' } },
    })
    expect(demoRequestLifecycle).toEqual(expect.arrayContaining([
      { status: 'opened', surface: 'persistent_form' },
      expect.objectContaining({
        status: 'failed',
        stage: 'submission',
        errorCode: 'demo_delivery_unavailable',
      }),
      expect.objectContaining({
        status: 'submitted',
        identityLinked: true,
        hasCompany: true,
        hasPhone: false,
      }),
      { status: 'opened', surface: 'voice_tool' },
    ]))
    await waitFor(() => contextBodies.some((body) => body.voiceUpgrade === true))
    expect(client.state.session?.sessionId).toBe('session_voice_widget')
    expect(voice.conversationId).toBe('conv_widget_123')

    capturedVoiceOptions.onMessage?.({ message: '[happy] I can guide the page.', source: 'ai', role: 'agent' })
    capturedVoiceOptions.onMessage?.({ message: 'Show pricing.', source: 'user', role: 'user' })
    capturedVoiceOptions.onMessage?.({
      message: '[happy] Welcome to Acme’s voice-first warehouse demo.',
      source: 'ai',
      role: 'agent',
    })
    capturedVoiceOptions.onMessage?.({ message: '[laughs]', source: 'ai', role: 'agent' })
    capturedVoiceOptions.onMessage?.({ message: '[happy] is what I typed.', source: 'user', role: 'user' })
    const transcriptText = required(widget.shadowRoot, '[data-messages]').textContent
    expect(transcriptText).toContain('I can guide the page.')
    expect(transcriptText).not.toContain('[happy] I can guide the page.')
    expect(transcriptText).not.toContain('[laughs]')
    expect(transcriptText).toContain('[happy] is what I typed.')
    expect(transcriptText.split('Welcome to Acme’s voice-first warehouse demo.')).toHaveLength(2)
    expect(widget.shadowRoot.querySelectorAll('[data-surface="voice"]')).toHaveLength(10)

    const unavailableSlide = JSON.parse(String(
      await capturedVoiceOptions.clientTools.show_slide?.({ filename: 'metadata-only.svg' }),
    ))
    expect(unavailableSlide).toMatchObject({ observation: { result: { status: 'not_found' } } })
    expect(widget.shadowRoot.querySelector('[data-surface="voice-presentation"]')).toBeNull()
    await capturedVoiceOptions.clientTools.show_slide?.({ filename: 'warehouse-roi.svg' })
    const voiceSlide = required(widget.shadowRoot, '[data-surface="voice-presentation"] img') as HTMLImageElement
    expect(voiceSlide.src).toBe('https://cdn.example.com/warehouse-roi.svg')
    expect(voiceSlide.alt).toBe('Warehouse ROI')

    await capturedVoiceOptions.clientTools.show_youtube_embed?.({
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      title: 'Warehouse tour',
      startSeconds: 12,
    })
    const voiceVideo = required(widget.shadowRoot, '[data-surface="voice-presentation"] iframe') as HTMLIFrameElement
    expect(voiceVideo.src).toContain('youtube-nocookie.com/embed/abcdefghijk')
    expect(voiceVideo.src).toContain('start=12')

    for (let index = 0; index < 25; index++) {
      capturedVoiceOptions.onMessage?.({
        message: `Bounded continuity turn ${index}`,
        source: index % 2 === 0 ? 'user' : 'ai',
        role: index % 2 === 0 ? 'user' : 'agent',
      })
    }

    widget.setMode('chat')
    expect(micMuted.at(-1)).toBe(true)
    expect(volume.at(-1)).toBe(0)
    expect(contextualUpdates.at(-1)).toContain('Stay silent')
    const composer = required(widget.shadowRoot, '[data-composer]') as HTMLTextAreaElement
    composer.value = 'Continue this exact thread in chat.'
    required(widget.shadowRoot, '[data-chat-form]').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
    await waitFor(() => chatBodies.length === 1)
    await waitFor(() => client.state.messages.some((message) => message.role === 'assistant' && message.text.includes('Continuing')))
    const channelHistory = chatBodies[0]?.history as Array<{ role: string; content: string }>
    expect(channelHistory).toHaveLength(20)
    expect(channelHistory.some((entry) => entry.content === 'Bounded continuity turn 0')).toBe(false)
    expect(channelHistory.at(-1)?.content).toBe('Bounded continuity turn 24')
    const chatSlide = required(widget.shadowRoot, '[data-surface="chat"] img') as HTMLImageElement
    expect(chatSlide.src).toBe('https://cdn.example.com/warehouse-roi.svg')
    const chatVideo = required(widget.shadowRoot, '[data-surface="chat"] iframe') as HTMLIFrameElement
    expect(chatVideo.src).toContain('youtube-nocookie.com/embed/abcdefghijk')
    widget.setMode('voice')
    expect(micMuted.at(-1)).toBe(false)
    expect(volume.at(-1)).toBe(1)
    expect(contextualUpdates.at(-1)).toContain('Voice mode resumed')

    required(widget.shadowRoot, '[data-voice-mute]').dispatchEvent(new Event('click', { bubbles: true }))
    required(widget.shadowRoot, '[data-voice-ptt]').dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    required(widget.shadowRoot, '[data-voice-ptt]').dispatchEvent(new Event('pointerup', { bubbles: true, cancelable: true }))
    expect(micMuted.slice(-3)).toEqual([true, false, true])

    required(widget.shadowRoot, '[data-voice-start]').dispatchEvent(new Event('click', { bubbles: true }))
    await waitFor(() => voice.state.status === 'disconnected')
    expect(endCalls).toBe(1)

    await widget.startVoice()
    await widget.endSession()
    await waitFor(() => endBodies.length === 1)
    widget.destroy()
    expect(endCalls).toBe(2)
    expect(endBodies[0]).toMatchObject({
      sessionId: 'session_voice_widget',
      elevenLabsConversationId: 'conv_widget_123',
      elevenLabsConversationIds: ['conv_widget_123'],
      slidesViewed: ['warehouse-roi.svg'],
    })
    const endedHistory = endBodies[0]?.clientMessages as Array<{ role: string; content: string }>
    expect(endedHistory).toHaveLength(20)
    expect(endedHistory.some((entry) => entry.content === 'Bounded continuity turn 24')).toBe(true)
    expect(endedHistory.some((entry) => entry.content === 'Continue this exact thread in chat.')).toBe(true)
  })

  test('allows a voice identity write only through an explicit per-turn host authorization', async () => {
    const client = await managedFeatureClient({
      orgName: 'Robot Store',
      orgSlug: 'demo',
      voiceEnabled: true,
      voiceMode: 'always_voice',
      slidesEnabled: false,
      suggestedQuestions: [],
    })
    let startOptions!: ElevenLabsStartSessionOptions
    const authorizedTurns: string[] = []
    const voice = new ConvincedVoiceController({
      descriptor: { agentId: 'agent_authorized_identity', genericClientTool: false },
      tools: new ClientToolRegistry(),
      orgSlug: 'demo',
      sessionId: () => client.state.session?.sessionId ?? null,
      authorizeToolCall: ({ tool, execution }) => {
        if (!tool.name.includes('confirm_visitor_form')) return false
        authorizedTurns.push(execution.turnId)
        return true
      },
      conversationFactory: async (options) => {
        startOptions = options
        options.onConnect?.({ conversationId: 'conv_authorized_identity' })
        return {
          async endSession() {},
          getId: () => 'conv_authorized_identity',
          setMicMuted() {},
          sendContextualUpdate() {},
          sendUserMessage() {},
          sendUserActivity() {},
        }
      },
    })
    const widget = mountConvincedWidget({
      client,
      voice,
      target: '#widget',
      placement: 'inline',
      autoInitialize: false,
    })

    await widget.startVoice()
    for (let index = 0; index < 3; index++) {
      startOptions.onMessage?.({ message: `Visitor turn ${index + 1}`, source: 'user', role: 'user' })
    }
    await startOptions.clientTools.set_visitor_field?.({ field: 'email', value: 'buyer@example.com' })
    await startOptions.clientTools.set_visitor_field?.({ field: 'name', value: 'Buyer' })
    const confirmation = JSON.parse(String(
      await startOptions.clientTools.confirm_visitor_form?.({}),
    ))

    expect(confirmation).toMatchObject({
      observation: { ok: true, result: { status: 'captured' } },
    })
    expect(authorizedTurns).toHaveLength(1)
    expect(authorizedTurns[0]).toMatch(/^turn_/)
    expect(client.state.identity).toMatchObject({ email: 'buyer@example.com', name: 'Buyer' })
    widget.destroy()
  })

  test('keeps smart-gate voice secondary until warmup and runs the managed profile gate', async () => {
    let factoryCalls = 0
    let capturedSmartVoiceOptions!: ElevenLabsStartSessionOptions
    const smartContextUpdates: string[] = []
    const intelCapabilities: string[] = []
    let intelReads = 0
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          return Response.json({
            sessionId: 'session_smart_gate',
            sessionCapability: 'capability_smart_gate',
            config: {
              orgName: 'Robot Store',
              orgSlug: 'demo',
              voiceEnabled: true,
              voiceMode: 'smart_gate',
              allowModeToggle: true,
              slidesEnabled: false,
              firstMessageEnabled: true,
              firstMessageText: 'Hello from the configured voice agent.',
              suggestedQuestions: [],
              pillsConfig: {
                enabled: false,
                warmupExchanges: 1,
                emailGateMessage: 'Share email',
                pills: [],
              },
            },
          })
        }
        if (url.pathname.endsWith('/chat')) return sse([{ delta: 'That is a useful first answer.' }])
        if (url.pathname.endsWith('/identity')) return Response.json({ visitorId: 'visitor_smart' })
        if (url.pathname.endsWith('/visitor-intel')) {
          intelCapabilities.push(new Headers(init.headers).get('x-widget-session-capability') ?? '')
          intelReads += 1
          if (intelReads === 1) return Response.json({ error: 'transient' }, { status: 503 })
          return Response.json({
            status: 'ready',
            companyName: 'Smart Corp',
            summary: 'Smart Corp is evaluating automated fulfillment.',
          })
        }
        if (url.pathname.endsWith('/context')) return Response.json({ ok: true })
        if (url.pathname.endsWith('/session/end')) return Response.json({ ok: true })
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession()
    const voice = new ConvincedVoiceController({
      descriptor: { agentId: 'agent_smart', genericClientTool: false },
      tools: new ClientToolRegistry(),
      orgSlug: 'demo',
      sessionId: 'session_smart_gate',
      conversationFactory: async (options) => {
        factoryCalls += 1
        capturedSmartVoiceOptions = options
        options.onConnect?.({ conversationId: 'conv_smart' })
        return {
          async endSession() {},
          getId: () => 'conv_smart',
          setMicMuted() {},
          sendContextualUpdate(text) { smartContextUpdates.push(text) },
          sendUserMessage() {},
          sendUserActivity() {},
        }
      },
    })
    const widget = mountConvincedWidget({
      client,
      voice,
      target: '#widget',
      placement: 'inline',
      autoInitialize: false,
    })
    const voiceMode = required(widget.shadowRoot, '[data-mode-voice]') as HTMLButtonElement
    expect(widget.host.dataset.mode).toBe('chat')
    expect(voiceMode.disabled).toBe(true)

    await client.sendMessage('How does this work?')
    expect(voiceMode.disabled).toBe(false)
    voiceMode.dispatchEvent(new Event('click', { bubbles: true }))
    const form = required(widget.shadowRoot, '.identity-form') as HTMLFormElement
    expect(form.querySelector('input[name="email"]')).not.toBeNull()
    expect(form.querySelector('input[name="role"]')).toBeNull()
    expect(factoryCalls).toBe(0)

    ;(form.querySelector('input[name="email"]') as unknown as HTMLInputElement).value = 'smart@example.com'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await waitFor(() => client.state.identity?.email === 'smart@example.com')
    await widget.startVoice()
    expect(factoryCalls).toBe(1)
    expect(voice.state.status).toBe('connected')
    expect(capturedSmartVoiceOptions.overrides).toMatchObject({
      agent: { firstMessage: 'Hello from the configured voice agent.' },
    })
    await Bun.sleep(1_550)
    await waitFor(() => smartContextUpdates.some((update) => update.includes('VISITOR_CONTEXT enriched')))
    expect(intelCapabilities).toEqual(['capability_smart_gate', 'capability_smart_gate'])
    widget.destroy()
  })

  test('falls back to a managed ElevenLabs text conversation when audio startup fails', async () => {
    const client = await managedFeatureClient({
      orgName: 'Robot Store',
      orgSlug: 'demo',
      voiceEnabled: true,
      voiceMode: 'always_voice',
      allowModeToggle: true,
      slidesEnabled: false,
      suggestedQuestions: [],
    })
    let descriptorCalls = 0
    let factoryCalls = 0
    let fallbackOptions!: ElevenLabsStartSessionOptions
    const sentMessages: string[] = []
    const muted: boolean[] = []
    const volume: number[] = []
    const voice = new ConvincedVoiceController({
      descriptorFactory: async () => ({ conversationToken: `fresh_token_${++descriptorCalls}`, genericClientTool: false }),
      tools: new ClientToolRegistry(),
      orgSlug: 'demo',
      sessionId: () => client.state.session?.sessionId ?? null,
      conversationFactory: async (options) => {
        factoryCalls += 1
        if (factoryCalls === 1) throw new Error('Microphone startup failed')
        fallbackOptions = options
        options.onConnect?.({ conversationId: 'conv_text_fallback' })
        return {
          async endSession() {},
          getId: () => 'conv_text_fallback',
          setMicMuted(value) { muted.push(value) },
          setVolume({ volume: value }) { volume.push(value) },
          sendContextualUpdate() {},
          sendUserMessage(value) { sentMessages.push(value) },
          sendUserActivity() {},
        }
      },
    })
    const widget = mountConvincedWidget({
      client, voice, target: '#widget', placement: 'inline', autoInitialize: false,
    })

    expect(await widget.startVoice()).toBe('started')
    expect(factoryCalls).toBe(2)
    expect(descriptorCalls).toBe(2)
    expect(voice.state).toMatchObject({ status: 'connected', textOnly: true, muted: true })
    expect(fallbackOptions.overrides).toMatchObject({ conversation: { textOnly: true } })
    expect(muted.at(-1)).toBe(true)
    expect(volume.at(-1)).toBe(0)
    expect(required(widget.shadowRoot, '[data-chat-form]').hasAttribute('hidden')).toBe(false)
    expect(required(widget.shadowRoot, '[data-voice-ptt]').hasAttribute('hidden')).toBe(true)
    expect(required(widget.shadowRoot, '[data-voice-status]').textContent).toContain('text-only')

    const composer = required(widget.shadowRoot, '[data-composer]') as HTMLTextAreaElement
    composer.value = 'Continue without microphone access.'
    required(widget.shadowRoot, '[data-chat-form]').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
    expect(sentMessages).toEqual(['Continue without microphone access.'])
    widget.destroy()
  })

  test('keeps email-gate chat-first, captures identity, and starts voice in the same locked-mode session', async () => {
    const sessionIds: string[] = []
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          sessionIds.push('session_email_gate')
          return Response.json({
            sessionId: 'session_email_gate',
            sessionCapability: 'capability_email_gate',
            config: {
              orgName: 'Robot Store', orgSlug: 'demo', voiceEnabled: true,
              voiceMode: 'email_gate', allowModeToggle: false,
              slidesEnabled: false, suggestedQuestions: [],
            },
          })
        }
        if (url.pathname.endsWith('/identity')) return Response.json({ visitorId: 'visitor_email_gate' })
        if (url.pathname.endsWith('/context')) return Response.json({ ok: true })
        if (url.pathname.endsWith('/visitor-intel')) return Response.json({ status: 'unavailable' })
        if (url.pathname.endsWith('/session/end')) return Response.json({ ok: true })
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession()
    let factoryCalls = 0
    let startOptions!: ElevenLabsStartSessionOptions
    const voice = new ConvincedVoiceController({
      descriptor: { agentId: 'agent_email_gate', genericClientTool: false },
      tools: new ClientToolRegistry(),
      orgSlug: 'demo',
      sessionId: () => client.state.session?.sessionId ?? null,
      conversationFactory: async (options) => {
        factoryCalls += 1
        startOptions = options
        options.onConnect?.({ conversationId: 'conv_email_gate' })
        return {
          async endSession() {}, getId: () => 'conv_email_gate', setMicMuted() {}, setVolume() {},
          sendContextualUpdate() {}, sendUserMessage() {}, sendUserActivity() {},
        }
      },
    })
    const widget = mountConvincedWidget({
      client, voice, target: '#widget', placement: 'inline', autoInitialize: false,
    })

    expect(widget.host.dataset.mode).toBe('chat')
    expect(required(widget.shadowRoot, '[data-mode-switch]').hasAttribute('hidden')).toBe(true)
    expect(await widget.startVoice()).toBe('identity_required')
    expect(factoryCalls).toBe(0)
    const form = required(widget.shadowRoot, '.identity-form') as HTMLFormElement
    const email = required(form, 'input[name="email"]') as HTMLInputElement
    email.value = 'email-gate@example.com'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await waitFor(() => client.state.identity?.email === 'email-gate@example.com')

    expect(await widget.startVoice()).toBe('started')
    expect(factoryCalls).toBe(1)
    expect(client.state.session?.sessionId).toBe('session_email_gate')
    expect(sessionIds).toEqual(['session_email_gate'])
    expect(startOptions.dynamicVariables).toMatchObject({ SESSION_ID: 'session_email_gate' })
    widget.setMode('chat')
    expect(widget.host.dataset.mode).toBe('voice')
    widget.destroy()
  })

  test('honors a deployment that locks the managed renderer to voice', async () => {
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          return Response.json({
            sessionId: 'session_locked_voice',
            config: {
              orgName: 'Robot Store',
              orgSlug: 'demo',
              voiceEnabled: true,
              voiceMode: 'voice_only',
              allowModeToggle: false,
              slidesEnabled: false,
              suggestedQuestions: [],
            },
          })
        }
        if (url.pathname.endsWith('/session/end')) return Response.json({ ok: true })
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession()
    const voice = new ConvincedVoiceController({
      descriptor: { agentId: 'agent_locked', genericClientTool: false },
      tools: new ClientToolRegistry(),
      orgSlug: 'demo',
      conversationFactory: async () => {
        throw new Error('Voice should not start in this render-only assertion.')
      },
    })
    const widget = mountConvincedWidget({
      client,
      voice,
      target: '#widget',
      placement: 'inline',
      autoInitialize: false,
    })

    expect(widget.host.dataset.mode).toBe('voice')
    expect(required(widget.shadowRoot, '[data-mode-switch]').hasAttribute('hidden')).toBe(true)
    expect(required(widget.shadowRoot, '[data-chat-form]').hasAttribute('hidden')).toBe(true)
    widget.setMode('chat')
    expect(widget.host.dataset.mode).toBe('voice')
    widget.destroy()
  })

  test('managed close ends voice and finalizes the Convinced session only once', async () => {
    let sessionEndCalls = 0
    let voiceEndCalls = 0
    const muted: boolean[] = []
    const volume: number[] = []
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          return Response.json({
            sessionId: 'session_close_once',
            config: {
              orgName: 'Robot Store',
              orgSlug: 'demo',
              voiceEnabled: true,
              voiceMode: 'always_voice',
              slidesEnabled: false,
              suggestedQuestions: [],
            },
          })
        }
        if (url.pathname.endsWith('/context')) return Response.json({ ok: true })
        if (url.pathname.endsWith('/session/end')) {
          sessionEndCalls += 1
          return Response.json({ ok: true })
        }
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession()
    const voice = new ConvincedVoiceController({
      descriptor: { agentId: 'agent_close_once', genericClientTool: false },
      tools: new ClientToolRegistry(),
      orgSlug: 'demo',
      conversationFactory: async (options) => {
        options.onConnect?.({ conversationId: 'conv_close_once' })
        return {
          async endSession() { voiceEndCalls += 1 },
          getId: () => 'conv_close_once',
          setMicMuted(value) { muted.push(value) },
          setVolume({ volume: next }) { volume.push(next) },
          sendContextualUpdate() {},
          sendUserMessage() {},
          sendUserActivity() {},
        }
      },
    })
    const widget = mountConvincedWidget({
      client,
      voice,
      target: '#widget',
      placement: 'floating',
      openByDefault: true,
      autoInitialize: false,
    })
    await widget.startVoice()

    widget.close()
    expect(muted.at(-1)).toBe(true)
    expect(volume.at(-1)).toBe(0)
    await waitFor(() => voiceEndCalls === 1 && sessionEndCalls === 1)
    widget.close()
    widget.destroy()
    await Bun.sleep(0)
    expect(voiceEndCalls).toBe(1)
    expect(sessionEndCalls).toBe(1)
  })

  test('reopens with a fresh attributed session and safely finalizes the second voice call', async () => {
    const sessionBodies: JsonObject[] = []
    const endedSessionIds: string[] = []
    let sessionCalls = 0
    let voiceStarts = 0
    let voiceEnds = 0
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          sessionCalls += 1
          sessionBodies.push(JSON.parse(String(init.body)) as JsonObject)
          return Response.json({
            sessionId: `session_reopen_${sessionCalls}`,
            config: {
              orgName: 'Robot Store', orgSlug: 'demo', voiceEnabled: true,
              voiceMode: 'always_voice', slidesEnabled: false, suggestedQuestions: [],
            },
          })
        }
        if (url.pathname.endsWith('/context')) return Response.json({ ok: true })
        if (url.pathname.endsWith('/session/end')) {
          const body = JSON.parse(String(init.body)) as JsonObject
          endedSessionIds.push(String(body.sessionId))
          return Response.json({ ok: true })
        }
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession({ c: 'campaign-preserved', pid: 'person-preserved' })
    const voice = new ConvincedVoiceController({
      descriptor: { agentId: 'agent_reopen', genericClientTool: false },
      tools: new ClientToolRegistry(),
      orgSlug: 'demo',
      sessionId: () => client.state.session?.sessionId ?? null,
      conversationFactory: async (options) => {
        voiceStarts += 1
        const id = `conv_reopen_${voiceStarts}`
        options.onConnect?.({ conversationId: id })
        return {
          async endSession() { voiceEnds += 1 },
          getId: () => id,
          setMicMuted() {},
          setVolume() {},
          sendContextualUpdate() {},
          sendUserMessage() {},
          sendUserActivity() {},
        }
      },
    })
    const widget = mountConvincedWidget({
      client, voice, target: '#widget', placement: 'floating',
      openByDefault: true, autoInitialize: false,
    })

    await widget.startVoice()
    widget.close()
    await waitFor(() => endedSessionIds.length === 1 && voiceEnds === 1)
    widget.open()
    await widget.startVoice()
    expect(client.state.session?.sessionId).toBe('session_reopen_2')
    expect(sessionBodies[1]).toMatchObject({
      c: 'campaign-preserved',
      pid: 'person-preserved',
    })
    widget.close()
    await waitFor(() => endedSessionIds.length === 2 && voiceEnds === 2)

    expect(endedSessionIds).toEqual(['session_reopen_1', 'session_reopen_2'])
    expect(voiceStarts).toBe(2)
    widget.destroy()
    await Bun.sleep(0)
    expect(voiceEnds).toBe(2)
  })

  test('managed chat-only close finalizes its session once', async () => {
    let endCalls = 0
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) {
          return Response.json({
            sessionId: 'session_chat_only',
            config: {
              orgName: 'Robot Store', orgSlug: 'demo', voiceEnabled: false,
              voiceMode: 'text_only', slidesEnabled: false, suggestedQuestions: [],
            },
          })
        }
        if (url.pathname.endsWith('/session/end')) {
          endCalls += 1
          return Response.json({ ok: true })
        }
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession()
    const widget = mountConvincedWidget({
      client, target: '#widget', placement: 'floating',
      openByDefault: true, autoInitialize: false,
    })

    widget.close()
    await waitFor(() => endCalls === 1)
    widget.close()
    widget.destroy()
    await Bun.sleep(0)
    expect(endCalls).toBe(1)
  })

  test('retries managed auto-initialization after a transient session failure', async () => {
    let sessionCalls = 0
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/config')) {
          return Response.json({
            orgName: 'Robot Store', orgSlug: 'demo', voiceEnabled: false,
            voiceMode: 'text_only', slidesEnabled: false, suggestedQuestions: [],
          })
        }
        if (url.pathname.endsWith('/session')) {
          sessionCalls += 1
          if (sessionCalls === 1) return new Response('temporary', { status: 503 })
          return Response.json({
            sessionId: 'session_retry_success',
            config: {
              orgName: 'Robot Store', orgSlug: 'demo', voiceEnabled: false,
              voiceMode: 'text_only', slidesEnabled: false, suggestedQuestions: [],
            },
          })
        }
        if (url.pathname.endsWith('/session/end')) return Response.json({ ok: true })
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    const widget = mountConvincedWidget({
      client, target: '#widget', placement: 'floating', openByDefault: true,
    })

    await waitFor(() => client.state.status === 'error', 'initial failure')
    expect({ sessionCalls, error: client.state.error?.message }).toEqual({
      sessionCalls: 1,
      error: 'temporary',
    })
    widget.open()
    for (let index = 0; index < 20 && !client.state.session; index++) await Bun.sleep(0)
    expect(sessionCalls).toBe(2)
    expect(client.state.session?.sessionId).toBe('session_retry_success')
    widget.destroy()
  })

  test('renders managed welcome, ticker, callout, engagement, and safe meeting surfaces', async () => {
    const chatBodies: JsonObject[] = []
    const client = await managedFeatureClient({
      orgName: 'Signal Foundry',
      orgSlug: 'demo',
      slidesEnabled: false,
      voiceEnabled: false,
      voiceMode: 'text_only',
      launcherStyle: 'ticker',
      launcherPosition: 'bottom-left',
      launcherCta: 'Ask Signal',
      launcherCalloutEnabled: true,
      launcherCallout: 'Get a live operations answer.',
      launcherPulseEnabled: false,
      v2Theme: 'spotlight',
      tickerColor: '#d97706',
      tickerLines: ['Trace every handoff', 'See the revenue path'],
      tickerLuxStyle: 'mercury',
      tickerBarEnabled: true,
      tickerIntroEnabled: true,
      meetingCtaText: 'Plan the rollout',
      meetingCtaUrl: 'https://example.com/book?source=widget',
      suggestedQuestions: [],
      engagementTriggers: {
        emailCapture: { enabled: true, mode: 'rules', pillText: 'Send my summary', afterMessages: 1 },
        resourceOffer: { enabled: true, mode: 'both', pillText: 'Show the field guide' },
        meetingCta: { enabled: true, mode: 'rules', pillText: 'Book the working session' },
      },
      pillsConfig: {
        enabled: false,
        warmupExchanges: 1,
        emailGateMessage: 'Where should the summary go?',
        pills: [],
        welcomeCard: {
          tagline: 'Turn buyer intent into a guided product conversation.',
          stats: [
            { value: '2.4×', label: 'faster qualification' },
            { value: '24/7', label: 'buyer coverage' },
          ],
          customerLogos: [
            { name: 'Northstar', logoUrl: 'https://cdn.example.com/northstar.svg' },
            { name: 'Unsafe logo', logoUrl: 'javascript:alert(1)' },
          ],
          ctaText: 'Start the conversation',
          backgroundColor: '#fff3e0',
        },
      },
    }, chatBodies)
    const widget = mountConvincedWidget({
      client,
      target: '#widget',
      placement: 'floating',
      openByDefault: true,
      autoInitialize: false,
    })

    expect(widget.host.dataset.launcherStyle).toBe('ticker')
    expect(widget.host.dataset.launcherPosition).toBe('bottom-left')
    expect(widget.host.dataset.widgetTheme).toBe('spotlight')
    expect(widget.host.dataset.tickerLuxStyle).toBe('mercury')
    expect(widget.host.dataset.tickerIntro).toBe('true')
    expect(widget.host.dataset.launcherPulse).toBe('false')
    expect(required(widget.shadowRoot, '[data-launcher-text]').textContent).toBe('Ask Signal')
    expect(required(widget.shadowRoot, '[data-launcher-callout]').textContent)
      .toBe('Get a live operations answer.')
    expect(required(widget.shadowRoot, '[data-launcher-callout]').hasAttribute('hidden')).toBe(false)
    expect(widget.shadowRoot.querySelectorAll('[data-ticker-line]')).toHaveLength(4)
    expect(required(widget.shadowRoot, '[data-ticker-intro]').textContent).toBe('Trace every handoff')
    expect((required(widget.shadowRoot, '[data-ticker-bar]') as HTMLElement).style
      .getPropertyValue('--convinced-ticker-color')).toBe('#d97706')

    const welcome = required(widget.shadowRoot, '[data-welcome-card]') as HTMLElement
    expect(welcome.hasAttribute('hidden')).toBe(false)
    expect(welcome.textContent).toContain('Turn buyer intent into a guided product conversation.')
    expect(welcome.textContent).toContain('2.4×')
    expect(welcome.textContent).toContain('Unsafe logo')
    expect(welcome.querySelectorAll('[data-welcome-logo] img')).toHaveLength(1)
    expect(welcome.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.com/northstar.svg')
    expect(welcome.querySelector('img')?.getAttribute('alt')).toBe('Northstar')
    expect(welcome.style.getPropertyValue('--convinced-welcome-background')).toBe('#fff3e0')

    let offers = Array.from(widget.shadowRoot.querySelectorAll<HTMLElement>('[data-engagement-offer]'))
    expect(offers.map((offer) => offer.dataset.engagementKind)).toEqual([
      'resource_offer',
      'meeting_cta',
    ])
    const meetingOffer = offers[1] as HTMLAnchorElement
    expect(meetingOffer.href).toBe('https://example.com/book?source=widget')
    expect(meetingOffer.target).toBe('_blank')
    expect(meetingOffer.rel).toBe('noopener noreferrer')
    expect(required(widget.shadowRoot, '[data-meeting-cta]').hasAttribute('hidden')).toBe(true)

    required(widget.shadowRoot, '[data-welcome-cta]').dispatchEvent(new Event('click', { bubbles: true }))
    expect(welcome.hasAttribute('hidden')).toBe(true)

    await client.sendMessage('Give me one useful answer')
    offers = Array.from(widget.shadowRoot.querySelectorAll<HTMLElement>('[data-engagement-offer]'))
    expect(offers.map((offer) => offer.dataset.engagementKind)).toEqual([
      'email_capture',
      'resource_offer',
      'meeting_cta',
    ])
    expect(required(widget.shadowRoot, '[data-engagement-offers]').getAttribute('data-threshold-basis'))
      .toBe('completed-assistant-turns')

    offers[0]?.dispatchEvent(new Event('click', { bubbles: true }))
    const identityForm = required(widget.shadowRoot, '.identity-form') as HTMLFormElement
    expect(identityForm.textContent).toContain('Send my summary')
    expect(identityForm.textContent).toContain('Where should the summary go?')
    ;(identityForm.querySelector('input[name="email"]') as unknown as HTMLInputElement).value = 'buyer@example.com'
    identityForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await waitFor(() => client.state.identity?.email === 'buyer@example.com')
    expect(widget.shadowRoot.querySelector('[data-engagement-kind="email_capture"]')).toBeNull()

    const resource = required(widget.shadowRoot, '[data-engagement-kind="resource_offer"]')
    resource.dispatchEvent(new Event('click', { bubbles: true }))
    await waitFor(() => chatBodies.length === 2)
    expect(chatBodies[1]).toMatchObject({ message: 'Show the field guide' })

    const css = required(widget.shadowRoot, 'style').textContent ?? ''
    for (const style of ['morph-pill', 'bottom-drawer', 'brutalist', 'gradient-ring', 'slide-over', 'spotlight', 'ticker']) {
      expect(css).toContain(`[data-launcher-style="${style}"]`)
    }
    for (const theme of ['frost-glass', 'brutalist', 'gradient-ring', 'slide-over', 'drawer', 'spotlight']) {
      expect(css).toContain(`[data-widget-theme="${theme}"]`)
    }
    widget.destroy()
  })

  test('applies managed agent chrome and removes legacy return-visitor PII storage', async () => {
    localStorage.setItem('convinced-visitor-demo', JSON.stringify({
      lastVisit: Date.now() - 2 * 24 * 60 * 60_000,
      lastTopic: '**warehouse routing** [PILLS:Ignore me]',
      email: 'ada@example.com',
      name: 'Ada Buyer',
      sessionCount: 2,
    }))
    const client = await managedFeatureClient({
      orgName: 'Signal Foundry',
      orgSlug: 'demo',
      agentName: 'Maya',
      agentTitle: 'Product specialist',
      agentAvatarUrl: 'https://cdn.example.com/maya.png',
      slidesEnabled: false,
      voiceEnabled: false,
      voiceMode: 'text_only',
      suggestedQuestions: [],
      showPoweredBy: true,
      expandEnabled: true,
      expandGlowColor: '#7c3aed',
      returnVisitorEnabled: true,
      returnVisitorDays: 7,
      returnVisitorGreeting: 'Welcome back, {name}. Continue {topic}?',
    })
    const widget = mountConvincedWidget({
      client,
      target: '#widget',
      placement: 'floating',
      openByDefault: true,
      autoInitialize: false,
    })

    expect(required(widget.shadowRoot, '[data-title]').textContent).toBe('Maya')
    expect(required(widget.shadowRoot, '[data-agent-title]').textContent).toBe('Product specialist')
    expect(widget.shadowRoot.querySelectorAll('[data-has-avatar="true"] img')).toHaveLength(3)
    expect(widget.shadowRoot.querySelector('[src^="javascript:"]')).toBeNull()
    const poweredBy = required(widget.shadowRoot, '[data-powered-by]')
    expect(poweredBy.hasAttribute('hidden')).toBe(false)
    expect(required(poweredBy, 'a').getAttribute('href')).toBe('https://getconvinced.ai')
    const expand = required(widget.shadowRoot, '[data-expand]') as HTMLButtonElement
    expect(expand.hasAttribute('hidden')).toBe(false)
    expect(widget.host.style.getPropertyValue('--convinced-expand-glow')).toBe('#7c3aed')
    expand.dispatchEvent(new Event('click', { bubbles: true }))
    expect(widget.host.dataset.expanded).toBe('true')
    expect(expand.getAttribute('aria-label')).toBe('Minimize assistant')
    expect(required(widget.shadowRoot, '[data-panel]').getAttribute('aria-modal')).toBe('true')
    expand.dispatchEvent(new Event('click', { bubbles: true }))
    expect(widget.host.dataset.expanded).toBe('false')
    expect(required(widget.shadowRoot, '[data-panel]').getAttribute('aria-modal')).toBeNull()
    expect(required(widget.shadowRoot, '[data-messages]').textContent)
      .not.toContain('Ada Buyer')
    expect(required(widget.shadowRoot, '[data-messages]').textContent)
      .not.toContain('warehouse routing')
    expect(localStorage.getItem('convinced-visitor-demo')).toBeNull()

    await client.sendMessage('Help with routing')
    widget.close()
    await Bun.sleep(0)
    expect(localStorage.getItem('convinced-visitor-demo')).toBeNull()
    widget.destroy()

    localStorage.setItem('convinced-visitor-demo', JSON.stringify({
      lastVisit: Date.now() - 2 * 24 * 60 * 60_000,
      lastTopic: 'expired private topic',
    }))
    const expiredClient = await managedFeatureClient({
      orgName: 'Signal Foundry',
      orgSlug: 'demo',
      agentName: 'Maya',
      agentAvatarUrl: 'https://user:secret@cdn.example.com/avatar.png',
      slidesEnabled: false,
      voiceEnabled: false,
      voiceMode: 'text_only',
      suggestedQuestions: [],
      showPoweredBy: false,
      expandEnabled: false,
      returnVisitorEnabled: true,
      returnVisitorDays: 1,
      returnVisitorGreeting: 'Resume {topic}',
    })
    const expiredWidget = mountConvincedWidget({
      client: expiredClient,
      target: '#widget',
      placement: 'floating',
      openByDefault: true,
      autoInitialize: false,
    })
    expect(required(expiredWidget.shadowRoot, '[data-messages]').textContent)
      .not.toContain('expired private topic')
    expect(localStorage.getItem('convinced-visitor-demo')).toBeNull()
    expect(required(expiredWidget.shadowRoot, '[data-powered-by]').hasAttribute('hidden')).toBe(true)
    expect(required(expiredWidget.shadowRoot, '[data-expand]').hasAttribute('hidden')).toBe(true)
    expect(expiredWidget.shadowRoot.querySelector('[data-has-avatar="true"]')).toBeNull()
    expiredWidget.destroy()
  })

  test('uses the configured greeting after deleting a legacy local return-visitor record', async () => {
    localStorage.setItem('convinced-visitor-demo', JSON.stringify({
      lastVisit: Date.now() - 60_000,
      lastTopic: 'warehouse routing',
      name: 'Ada Buyer',
      sessionCount: 2,
    }))
    const client = await managedFeatureClient({
      orgName: 'Signal Foundry',
      orgSlug: 'demo',
      voiceEnabled: true,
      voiceMode: 'always_voice',
      slidesEnabled: false,
      suggestedQuestions: [],
      firstMessageEnabled: true,
      firstMessageText: 'Generic configured greeting.',
      returnVisitorEnabled: true,
      returnVisitorDays: 7,
      returnVisitorGreeting: 'Welcome back, {name}. Continue {topic}?',
    })
    let startOptions!: ElevenLabsStartSessionOptions
    const voice = new ConvincedVoiceController({
      descriptor: { agentId: 'agent_return_visitor', genericClientTool: false },
      tools: new ClientToolRegistry(),
      orgSlug: 'demo',
      sessionId: () => client.state.session?.sessionId ?? null,
      conversationFactory: async (options) => {
        startOptions = options
        options.onConnect?.({ conversationId: 'conv_return_visitor' })
        return {
          async endSession() {},
          getId: () => 'conv_return_visitor',
          setMicMuted() {},
          setVolume() {},
          sendContextualUpdate() {},
          sendUserMessage() {},
          sendUserActivity() {},
        }
      },
    })
    const widget = mountConvincedWidget({
      client, voice, target: '#widget', placement: 'inline', autoInitialize: false,
    })
    const greeting = 'Generic configured greeting.'
    expect(required(widget.shadowRoot, '[data-messages]').textContent).toContain(greeting)
    expect(required(widget.shadowRoot, '[data-messages]').textContent).not.toContain('Ada Buyer')
    expect(localStorage.getItem('convinced-visitor-demo')).toBeNull()
    await widget.startVoice()
    expect(startOptions.overrides).toMatchObject({ agent: { firstMessage: greeting } })
    widget.destroy()
  })

  test('speaks the resolved server return-visitor greeting before the configured generic opener', async () => {
    localStorage.clear()
    const config = {
      orgName: 'Signal Foundry',
      orgSlug: 'demo',
      voiceEnabled: true,
      voiceMode: 'always_voice',
      slidesEnabled: false,
      suggestedQuestions: [],
      firstMessageEnabled: true,
      firstMessageText: 'Generic configured greeting.',
      returnVisitorEnabled: true,
      returnVisitorDays: 7,
      returnVisitorGreeting: 'Welcome back, {name}. Continue {topic}?',
    }
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/session')) return Response.json({
          sessionId: 'session_server_return',
          config,
          returnVisitor: {
            previousTopics: ['dock scheduling'],
            lastSessionDate: new Date().toISOString(),
          },
        })
        if (url.pathname.endsWith('/context')) return Response.json({ ok: true })
        if (url.pathname.endsWith('/session/end')) return Response.json({ ok: true })
        throw new Error(`Unexpected mock URL: ${url}`)
      }) as typeof fetch,
    })
    await client.createSession()
    let startOptions!: ElevenLabsStartSessionOptions
    const voice = new ConvincedVoiceController({
      descriptor: { agentId: 'agent_server_return', genericClientTool: false },
      tools: new ClientToolRegistry(),
      orgSlug: 'demo',
      sessionId: () => client.state.session?.sessionId ?? null,
      conversationFactory: async (options) => {
        startOptions = options
        options.onConnect?.({ conversationId: 'conv_server_return' })
        return {
          async endSession() {}, getId: () => 'conv_server_return', setMicMuted() {}, setVolume() {},
          sendContextualUpdate() {}, sendUserMessage() {}, sendUserActivity() {},
        }
      },
    })
    const widget = mountConvincedWidget({
      client, voice, target: '#widget', placement: 'inline', autoInitialize: false,
    })
    const greeting = 'Welcome back, there. Continue dock scheduling?'
    expect(required(widget.shadowRoot, '[data-messages]').textContent).toContain(greeting)
    await widget.startVoice()
    expect(startOptions.overrides).toMatchObject({ agent: { firstMessage: greeting } })
    widget.destroy()
  })

  test('keeps ai-decides offers adaptive while retaining the configured safe meeting CTA', async () => {
    const client = await managedFeatureClient({
      orgName: 'Signal Foundry',
      orgSlug: 'demo',
      slidesEnabled: false,
      voiceEnabled: false,
      meetingCtaText: 'Plan the rollout',
      meetingCtaUrl: 'https://example.com/plan',
      suggestedQuestions: [],
      engagementTriggers: {
        emailCapture: { enabled: true, mode: 'ai_decides', pillText: 'Email', afterMessages: 0 },
        resourceOffer: { enabled: true, mode: 'ai_decides', pillText: 'Resources' },
        meetingCta: { enabled: true, mode: 'ai_decides', pillText: 'Meeting' },
      },
    })
    const demoLifecycle: unknown[] = []
    client.on('demo_request', (event) => demoLifecycle.push(event))
    const widget = mountConvincedWidget({
      client,
      target: '#widget',
      placement: 'inline',
      autoInitialize: false,
    })

    expect(widget.shadowRoot.querySelectorAll('[data-engagement-offer]')).toHaveLength(0)
    const meeting = required(widget.shadowRoot, '[data-meeting-cta]') as HTMLAnchorElement
    expect(meeting.hasAttribute('hidden')).toBe(false)
    expect(meeting.href).toBe('https://example.com/plan')
    expect(meeting.target).toBe('_blank')
    expect(meeting.rel).toBe('noopener noreferrer')
    meeting.dispatchEvent(new Event('click', { bubbles: true }))
    expect(demoLifecycle).toEqual([])
    widget.destroy()
  })

  test('rejects unsafe or credential-bearing meeting URLs', async () => {
    for (const meetingCtaUrl of ['javascript:alert(1)', 'https://user:secret@example.com/book']) {
      const client = await managedFeatureClient({
        orgName: 'Signal Foundry',
        orgSlug: 'demo',
        slidesEnabled: false,
        voiceEnabled: false,
        meetingCtaText: 'Unsafe link',
        meetingCtaUrl,
        suggestedQuestions: [],
      })
      const widget = mountConvincedWidget({
        client,
        target: '#widget',
        placement: 'inline',
        autoInitialize: false,
      })

      const meeting = required(widget.shadowRoot, '[data-meeting-cta]')
      expect(meeting.hasAttribute('hidden')).toBe(true)
      expect(meeting.hasAttribute('href')).toBe(false)
      expect(widget.shadowRoot.querySelector('[href^="javascript:"]')).toBeNull()
      widget.destroy()
    }
  })

  test('honors disabled callout, ticker bar, and ticker intro flags', async () => {
    const client = await managedFeatureClient({
      orgName: 'Signal Foundry',
      orgSlug: 'demo',
      slidesEnabled: false,
      voiceEnabled: false,
      launcherStyle: 'ticker',
      launcherCalloutEnabled: false,
      launcherCallout: 'Do not render this callout',
      tickerLines: ['Do not render this ticker'],
      tickerBarEnabled: false,
      tickerIntroEnabled: true,
      suggestedQuestions: [],
    })
    const widget = mountConvincedWidget({
      client,
      target: '#widget',
      placement: 'floating',
      autoInitialize: false,
    })

    expect(required(widget.shadowRoot, '[data-launcher-callout]').hasAttribute('hidden')).toBe(true)
    expect(required(widget.shadowRoot, '[data-ticker-bar]').hasAttribute('hidden')).toBe(true)
    expect(required(widget.shadowRoot, '[data-ticker-intro]').hasAttribute('hidden')).toBe(true)
    widget.destroy()
  })

  test('does not impose managed presentation surfaces on the minimal preset', async () => {
    const client = await managedFeatureClient({
      orgName: 'Signal Foundry',
      orgSlug: 'demo',
      slidesEnabled: false,
      voiceEnabled: false,
      launcherStyle: 'ticker',
      launcherCalloutEnabled: true,
      launcherCallout: 'Managed callout',
      tickerLines: ['Managed ticker'],
      meetingCtaUrl: 'https://example.com/book',
      engagementTriggers: {
        resourceOffer: { enabled: true, mode: 'rules', pillText: 'Resources' },
      },
      pillsConfig: {
        enabled: false,
        warmupExchanges: 1,
        emailGateMessage: 'Email',
        pills: [],
        welcomeCard: {
          tagline: 'Managed welcome',
          stats: [],
          customerLogos: [],
          ctaText: 'Begin',
        },
      },
    })
    const widget = mountConvincedWidget({
      client,
      preset: 'minimal',
      target: '#widget',
      placement: 'inline',
      autoInitialize: false,
    })

    expect(widget.host.dataset.launcherStyle).toBe('minimal')
    expect(widget.host.dataset.widgetTheme).toBe('minimal')
    for (const selector of [
      '[data-launcher-callout]',
      '[data-ticker-bar]',
      '[data-ticker-intro]',
      '[data-welcome-card]',
      '[data-engagement-offers]',
      '[data-meeting-cta]',
    ]) {
      expect(required(widget.shadowRoot, selector).hasAttribute('hidden')).toBe(true)
    }
    widget.destroy()
  })

  test('routes the managed welcome CTA to first-hold PTT before the in-conversation identity gate', async () => {
    let factoryCalls = 0
    let welcomeVoiceOptions!: ElevenLabsStartSessionOptions
    const client = await managedFeatureClient({
      orgName: 'Signal Foundry',
      orgSlug: 'demo',
      slidesEnabled: false,
      voiceEnabled: true,
      voiceMode: 'always_voice',
      suggestedQuestions: [],
      pillsConfig: {
        enabled: false,
        warmupExchanges: 1,
        emailGateMessage: 'Email',
        pills: [],
        welcomeCard: {
          tagline: 'Talk through your use case live.',
          stats: [],
          customerLogos: [],
          ctaText: 'Start voice',
        },
      },
    })
    const voice = new ConvincedVoiceController({
      descriptor: { agentId: 'agent_welcome', genericClientTool: false },
      tools: new ClientToolRegistry(),
      orgSlug: 'demo',
      sessionId: () => client.state.session?.sessionId ?? null,
      conversationFactory: async (options) => {
        factoryCalls += 1
        welcomeVoiceOptions = options
        options.onConnect?.({ conversationId: 'conv_welcome' })
        return {
          async endSession() {},
          getId: () => 'conv_welcome',
          setMicMuted() {},
          setVolume() {},
          sendContextualUpdate() {},
          sendUserMessage() {},
          sendUserActivity() {},
        }
      },
    })
    const widget = mountConvincedWidget({
      client,
      voice,
      target: '#widget',
      placement: 'inline',
      autoInitialize: false,
    })

    required(widget.shadowRoot, '[data-welcome-cta]').dispatchEvent(new Event('click', { bubbles: true }))
    expect(factoryCalls).toBe(0)
    const ptt = required(widget.shadowRoot, '[data-voice-ptt]')
    ptt.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    await waitFor(() => voice.state.status === 'connected')
    expect(factoryCalls).toBe(1)
    expect(voice.state.pushToTalkActive).toBe(true)
    ptt.dispatchEvent(new Event('pointerup', { bubbles: true, cancelable: true }))
    expect(voice.state.muted).toBe(true)
    expect(widget.shadowRoot.querySelector('.identity-form')).toBeNull()
    for (const message of ['One', 'Two', 'Three']) {
      welcomeVoiceOptions.onMessage?.({ message, source: 'user', role: 'user' })
    }
    await waitFor(() => widget.shadowRoot.querySelector('.identity-form') !== null)
    expect(widget.host.dataset.mode).toBe('voice')
    expect(required(widget.shadowRoot, '[data-welcome-card]').hasAttribute('hidden')).toBe(true)
    expect(required(widget.shadowRoot, '.identity-form').textContent).toContain('Unlock the voice conversation')
    widget.destroy()
  })

  test('single-flights first-hold PTT and always mutes on early release, capture loss, and blur', async () => {
    const client = await managedFeatureClient({
      orgName: 'Signal Foundry', orgSlug: 'demo', slidesEnabled: false,
      voiceEnabled: true, voiceMode: 'always_voice', suggestedQuestions: [],
    })
    let resolveConversation!: (conversation: {
      endSession(): Promise<void>
      getId(): string
      setMicMuted(value: boolean): void
      setVolume(): void
      sendContextualUpdate(): void
      sendUserMessage(): void
      sendUserActivity(): void
    }) => void
    const delayedConversation = new Promise<{
      endSession(): Promise<void>
      getId(): string
      setMicMuted(value: boolean): void
      setVolume(): void
      sendContextualUpdate(): void
      sendUserMessage(): void
      sendUserActivity(): void
    }>((resolve) => { resolveConversation = resolve })
    const micMuted: boolean[] = []
    let factoryCalls = 0
    const voice = new ConvincedVoiceController({
      descriptor: { agentId: 'agent_ptt_first', genericClientTool: false },
      tools: new ClientToolRegistry(),
      orgSlug: 'demo',
      sessionId: () => client.state.session?.sessionId ?? null,
      conversationFactory: async (options) => {
        factoryCalls += 1
        options.onConnect?.({ conversationId: 'conv_ptt_first' })
        return delayedConversation
      },
    })
    const widget = mountConvincedWidget({
      client, voice, target: '#widget', placement: 'inline', autoInitialize: false,
    })
    const ptt = required(widget.shadowRoot, '[data-voice-ptt]')

    ptt.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    ptt.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    await waitFor(() => factoryCalls === 1 && voice.state.status === 'connected')
    ptt.dispatchEvent(new Event('pointerup', { bubbles: true, cancelable: true }))
    expect(required(widget.shadowRoot, '[data-error]').hasAttribute('hidden')).toBe(true)
    resolveConversation({
      async endSession() {},
      getId: () => 'conv_ptt_first',
      setMicMuted(value) { micMuted.push(value) },
      setVolume() {},
      sendContextualUpdate() {},
      sendUserMessage() {},
      sendUserActivity() {},
    })
    await waitFor(() => voice.state.muted && voice.state.status === 'connected')
    await waitFor(() => micMuted.length >= 2)
    await Bun.sleep(0)
    expect(factoryCalls).toBe(1)
    expect(micMuted.every((value) => value)).toBe(true)

    ptt.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    expect(voice.state.pushToTalkActive).toBe(true)
    ptt.dispatchEvent(new Event('lostpointercapture', { bubbles: true, cancelable: true }))
    expect(voice.state.muted).toBe(true)

    const keyboardDown = new Event('keydown', { bubbles: true, cancelable: true })
    Object.defineProperties(keyboardDown, { key: { value: ' ' }, repeat: { value: false } })
    ptt.dispatchEvent(keyboardDown)
    expect(voice.state.pushToTalkActive).toBe(true)
    ptt.dispatchEvent(new Event('blur'))
    expect(voice.state.muted).toBe(true)
    widget.destroy()
  })
})

async function widgetClient(options: {
  disableInput: boolean
  identityBodies?: JsonObject[]
}): Promise<ConvincedClient> {
  const fetchMock = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/session')) {
      return Response.json({
        sessionId: 'session_widget',
        config: {
          orgName: 'Robot Store',
          orgSlug: 'demo',
          slidesEnabled: false,
          suggestedQuestions: ['Show me the robot'],
        },
      })
    }
    if (url.pathname.endsWith('/identity')) {
      options.identityBodies?.push(JSON.parse(String(init.body)) as JsonObject)
      return Response.json({ visitorId: 'visitor_123' })
    }
    if (url.pathname.endsWith('/context')) return Response.json({ ok: true })
    if (url.pathname.endsWith('/chat')) {
      return sse([
        { type: 'profile_gate', reason: 'demo', disableInput: options.disableInput },
        { delta: 'Here is the tailored answer.' },
      ])
    }
    throw new Error(`Unexpected mock URL: ${url}`)
  }) as typeof fetch
  const client = new ConvincedClient({
    orgSlug: 'demo',
    apiBase: 'https://mock.example',
    fetch: fetchMock,
  })
  await client.createSession()
  return client
}

async function managedFeatureClient(
  config: JsonObject,
  chatBodies: JsonObject[] = [],
): Promise<ConvincedClient> {
  const client = new ConvincedClient({
    orgSlug: 'demo',
    apiBase: 'https://mock.example',
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/session')) {
        return Response.json({ sessionId: 'session_managed_features', config })
      }
      if (url.pathname.endsWith('/chat')) {
        chatBodies.push(JSON.parse(String(init.body)) as JsonObject)
        return sse([{ delta: 'Here is a focused answer.' }])
      }
      if (url.pathname.endsWith('/identity')) {
        return Response.json({ visitorId: 'visitor_managed_features' })
      }
      if (url.pathname.endsWith('/context')) return Response.json({ ok: true })
      if (url.pathname.endsWith('/session/end')) return Response.json({ ok: true })
      throw new Error(`Unexpected mock URL: ${url}`)
    }) as typeof fetch,
  })
  await client.createSession()
  return client
}

function installDom(): () => void {
  const window = parseHTML('<!doctype html><html><body><main id="widget"></main></body></html>')
  const localStorage = new TestStorage()
  const previous = new Map<string, PropertyDescriptor | undefined>()
  const values: Record<string, unknown> = {
    document: window.document,
    window,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    FormData: TestFormData,
    localStorage,
  }
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
}

class TestStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(String(key), String(value))
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  clear(): void {
    this.values.clear()
  }
}

class TestFormData {
  private readonly values = new Map<string, string>()

  constructor(form?: HTMLFormElement) {
    for (const field of form?.querySelectorAll<HTMLInputElement>('[name]') ?? []) {
      this.values.set(field.name, field.value)
    }
  }

  get(name: string): string | null {
    return this.values.get(name) ?? null
  }
}

function required(root: ParentNode, selector: string): Element {
  const element = root.querySelector(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}

async function waitFor(predicate: () => boolean, label = 'widget state'): Promise<void> {
  for (let index = 0; index < 20; index++) {
    if (predicate()) return
    await Bun.sleep(0)
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

function sse(events: unknown[]): Response {
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}

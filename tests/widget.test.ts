import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import { ConvincedClient, mountConvincedWidget, type JsonObject } from '../src'

describe('optional managed renderer', () => {
  let restoreDom: (() => void) | undefined

  beforeEach(() => { restoreDom = installDom() })
  afterEach(() => { restoreDom?.() })

  test('renders Luna slide content inline without a page-taking link', async () => {
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: widgetFetch({ voiceEnabled: false }),
    })
    await client.initialize({ session: { pageUrl: 'https://site.example/transformation' } })
    const widget = mountConvincedWidget({
      client,
      target: '#widget',
      placement: 'inline',
      autoInitialize: false,
    })

    await client.sendMessage('Show the ROI slide')

    const image = required(widget.shadowRoot, 'article.message.assistant img') as HTMLImageElement
    expect(image.src).toBe('https://cdn.example/roi.svg')
    expect(image.alt).toBe('ROI proof')
    expect(image.closest('a')).toBeNull()
    widget.destroy()
  })

  test('exposes click-to-start and mute controls without push-to-talk', async () => {
    const client = new ConvincedClient({
      orgSlug: 'demo',
      apiBase: 'https://mock.example',
      fetch: widgetFetch({ voiceEnabled: true, voiceMode: 'always_voice' }),
    })
    await client.createSession({ pageUrl: 'https://site.example/transformation' })
    const live = client.createLiveController()
    const widget = mountConvincedWidget({
      client,
      voice: live,
      target: '#widget',
      placement: 'inline',
      autoInitialize: false,
    })

    expect(required(widget.shadowRoot, '[data-voice-start]').textContent).toContain('Start voice')
    expect(required(widget.shadowRoot, '[data-voice-mute]').textContent).toBe('Mute')
    expect(widget.shadowRoot.querySelector('[data-voice-ptt]')).toBeNull()
    widget.destroy()
  })
})

function widgetFetch(config: JsonObject): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/config')) {
      return Response.json({
        orgName: 'Demo', orgSlug: 'demo', slidesEnabled: true,
        suggestedQuestions: [], ...config,
      })
    }
    if (url.pathname.endsWith('/session')) {
      return Response.json({
        sessionId: 'session_widget',
        sessionCapability: 'capability_widget',
        config: {
          orgName: 'Demo', orgSlug: 'demo', slidesEnabled: true,
          suggestedQuestions: [], ...config,
        },
      })
    }
    if (url.pathname.endsWith('/slides/metadata')) {
      return Response.json({
        slides: [{ filename: 'roi.svg', title: 'ROI proof', description: 'Verified ROI proof.' }],
      })
    }
    if (url.pathname.endsWith('/slides')) {
      return Response.json({
        slides: [{ key: 'slides/roi.svg', filename: 'roi.svg', url: 'https://cdn.example/roi.svg' }],
      })
    }
    if (url.pathname.endsWith('/chat')) {
      return sse([{ delta: 'Here is the proof.\n\n[SLIDE:roi.svg]' }])
    }
    if (url.pathname.endsWith('/session/end')) return Response.json({ ok: true })
    throw new Error(`Unexpected mock URL: ${url}`)
  }) as unknown as typeof fetch
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
    CustomEvent: window.CustomEvent,
    FormData: class {},
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
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(String(key), String(value)) }
  removeItem(key: string): void { this.values.delete(key) }
  clear(): void { this.values.clear() }
}

function required(root: ParentNode, selector: string): Element {
  const element = root.querySelector(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}

function sse(events: unknown[]): Response {
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}

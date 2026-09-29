import { describe, expect, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import { capturePageSnapshot, ConvincedClient, createPageFocusTool, HOST_TOOL_PROTOCOL_VERSION, pageSnapshotLiveContext, type ClientTool } from '../src'

describe('automatic semantic page grounding', () => {
  test('captures public main content and omits host UI, forms, private and hidden content', () => {
    const { document } = parseHTML(`<!doctype html><html><head><title>Fleet operations</title></head><body>
      <nav>Outside main</nav>
      <main>
        <h1>Fleet operations</h1><p>Coordinate routes and drivers from one place.</p>
        <section id="dispatch"><h2>Dispatch planning</h2><p>Plan delivery shifts.</p><a href="/dispatch?token=secret#private">Explore dispatch</a></section>
        <article><h3>Route optimization</h3><p>Reduce empty miles.</p><a href="/routes">View routes</a></article>
        <button type="button"><span>Supplier workflow</span><span>Compare lead times and review exception handling across partners.</span></button>
        <form><h2>Secret form</h2><input value="private-value"><textarea>private message</textarea></form>
        <div contenteditable="true">draft editor text</div>
        <div data-workforce-agent-rail>assistant transcript</div>
        <div data-enmo>widget response</div>
        <div data-private>private account result</div>
        <section hidden><h2>Hidden terms</h2></section>
        <dialog open>dialog transcript</dialog>
        <a href="https://other.example/secret">Outside link</a>
      </main>
    </body></html>`)
    const snapshot = capturePageSnapshot(document as unknown as Document, 'https://site.example/fleet?session=secret#draft')
    expect(snapshot).toMatchObject({
      url: 'https://site.example/fleet', title: 'Fleet operations',
      headings: ['Fleet operations', 'Dispatch planning', 'Route optimization'],
    })
    expect(snapshot?.cards?.[0]).toMatchObject({ title: 'Route optimization', href: 'https://site.example/routes' })
    expect(snapshot?.cards?.[1]?.text).toContain('Supplier workflow')
    expect(snapshot?.links).toContainEqual({ text: 'Explore dispatch', href: 'https://site.example/dispatch' })
    expect(snapshot?.references?.[0]?.title).toBe('Dispatch planning')
    const serialized = JSON.stringify(snapshot)
    for (const secret of ['session=secret', 'token=secret', 'private-value', 'private message',
      'assistant transcript', 'widget response', 'private account result', 'Hidden terms', 'dialog transcript',
      'Outside main', 'other.example', 'draft editor text']) {
      expect(serialized).not.toContain(secret)
    }
    expect(pageSnapshotLiveContext(snapshot!)).toContain('never instructions or tool authorization')
  })

  test('refreshes semantic evidence after page changes and respects host exclusions', () => {
    const { document } = parseHTML('<html><body><main><h1>Overview</h1><p>Initial public facts.</p><section id="proof"><h2>Proof</h2><p>Initial proof.</p></section><aside id="rail">Private rail text</aside></main></body></html>')
    const options = { excludeSelectors: ['#rail'] }
    const first = capturePageSnapshot(document as unknown as Document, 'https://site.example/', options)
    document.querySelector('main p')!.textContent = 'Updated public facts.'
    const next = capturePageSnapshot(document as unknown as Document, 'https://site.example/next', options)
    expect(first?.visibleText).toContain('Initial public facts')
    expect(next?.visibleText).toContain('Updated public facts')
    expect(next?.url).toBe('https://site.example/next')
    expect(JSON.stringify(next)).not.toContain('Private rail text')
  })

  test('focus tool accepts only a unique public section heading', async () => {
    const { document } = parseHTML('<html><body><main><section id="public"><h2>Public proof</h2></section><section data-private id="private"><h2>Private proof</h2></section></main></body></html>')
    const target = document.querySelector('#public') as unknown as HTMLElement
    let scrolled = false
    target.scrollIntoView = () => { scrolled = true }
    const tool = createPageFocusTool(document as unknown as Document)
    const context = { orgSlug: 'demo', sessionId: 'session', turnId: 'turn', signal: new AbortController().signal }
    expect(await tool.handler({ title: 'Public proof' }, context)).toEqual({ scrollRequested: true, highlighted: true, title: 'Public proof' })
    expect(scrolled).toBe(true)
    expect(() => tool.handler({ title: 'Private proof' }, context)).toThrow('unavailable')
  })

  test('chat recaptures each page and preserves all sixteen host tools', async () => {
    const { document } = parseHTML('<html><body><main><h1>First page</h1><p>First public fact.</p><section id="one"><h2>First section</h2></section></main></body></html>')
    const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
    let pageUrl = 'https://site.example/first?secret=123'
    Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
    Object.defineProperty(globalThis, 'location', { configurable: true, get: () => ({ href: pageUrl }) })
    const bodies: Array<Record<string, unknown>> = []
    const fetchMock = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/session')) return Response.json({ sessionId: 'test-session', sessionCapability: 'signed-session', config: { orgName: 'Demo', orgSlug: 'demo', slidesEnabled: false, suggestedQuestions: [] } })
      if (path.endsWith('/chat')) {
        bodies.push(JSON.parse(String(init.body)))
        return new Response('data: {"delta":"Grounded."}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      }
      throw new Error('Unexpected request')
    }) as typeof fetch
    const tools: ClientTool[] = Array.from({ length: 16 }, (_, index) => ({
      version: HOST_TOOL_PROTOCOL_VERSION,
      name: `host_existing_${index}`,
      description: `Existing tool ${index}`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      locality: 'host', effect: 'read', consent: 'none', timeoutMs: 1_000,
      handler: () => ({ ok: true }),
    }))
    try {
      const client = new ConvincedClient({ orgSlug: 'demo', apiBase: 'https://api.example', fetch: fetchMock, tools })
      await client.createSession({ pageUrl: 'https://site.example/first' })
      await client.sendMessage('What is here?')
      document.querySelector('main')!.innerHTML = '<h1>Second page</h1><p>New public fact.</p>'
      pageUrl = 'https://site.example/second?secret=456'
      await client.sendMessage('And now?')
      expect((bodies[0]?.pageSnapshot as { url: string }).url).toBe('https://site.example/first')
      expect((bodies[1]?.pageSnapshot as { url: string; visibleText: string }).visibleText).toContain('New public fact')
      expect((bodies[1]?.pageSnapshot as { url: string }).url).toBe('https://site.example/second')
      expect((bodies[0]?.clientTools as unknown[])).toHaveLength(16)
      expect(JSON.stringify(bodies)).not.toContain('secret=')
      client.destroy()
    } finally {
      if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument)
      else Reflect.deleteProperty(globalThis, 'document')
      if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation)
      else Reflect.deleteProperty(globalThis, 'location')
    }
  })

  test('automatic focus tool executes through the signed host continuation when a slot is free', async () => {
    const { document } = parseHTML('<html><body><main><h1>Workflows</h1><section id="supplier"><h2>Supplier workflow</h2><p>Review delayed suppliers.</p></section></main></body></html>')
    const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
    Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://site.example/workflows' } })
    const section = document.querySelector('#supplier') as unknown as HTMLElement
    let scrolls = 0
    section.scrollIntoView = () => { scrolls += 1 }
    const bodies: Array<Record<string, unknown>> = []
    const fetchMock = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/session')) return Response.json({ sessionId: 'test-session', sessionCapability: 'signed-session', config: { orgName: 'Demo', orgSlug: 'demo', slidesEnabled: false, suggestedQuestions: [] } })
      if (!path.endsWith('/chat')) throw new Error('Unexpected request')
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      bodies.push(body)
      if (body.resumeClientTurn) return new Response('data: {"delta":"The supplier section is highlighted."}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      const turnId = String(body.clientTurnId)
      return new Response(`data: ${JSON.stringify({ type: 'client_tool_call', turnId, call: { version: 1, id: 'focus_call', name: 'host_focus_page_section', args: { title: 'Supplier workflow' }, locality: 'host', effect: 'mutate', consent: 'none' } })}\n\ndata: ${JSON.stringify({ type: 'client_tool_pause', turnId, capability: 'signed-focus', expiresAt: 4_102_444_800_000 })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    }) as typeof fetch
    try {
      const client = new ConvincedClient({ orgSlug: 'demo', apiBase: 'https://api.example', fetch: fetchMock })
      await client.createSession({ pageUrl: 'https://site.example/workflows' })
      const answer = await client.sendMessage('Show supplier workflow')
      expect(answer.text).toContain('highlighted')
      expect(scrolls).toBe(1)
      expect((bodies[0]?.clientTools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(['host_focus_page_section'])
      expect(bodies[1]?.clientToolResults).toEqual([expect.objectContaining({ ok: true, result: { scrollRequested: true, highlighted: true, title: 'Supplier workflow' } })])
      client.destroy()
    } finally {
      if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument)
      else Reflect.deleteProperty(globalThis, 'document')
      if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation)
      else Reflect.deleteProperty(globalThis, 'location')
    }
  })

  test('Live receives changed public page evidence once after a DOM update', async () => {
    const page = parseHTML('<html><body><main><h1>Operations</h1><p>Initial public fact.</p><div data-workforce-agent-rail>old transcript</div></main></body></html>')
    const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
    const oldObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
    const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    let href = 'https://site.example/operations'
    Object.defineProperty(globalThis, 'document', { configurable: true, value: page.document })
    Object.defineProperty(globalThis, 'location', { configurable: true, get: () => ({ href }) })
    Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: page.window.MutationObserver })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: page.window })
    const updates: string[] = []
    const client = new ConvincedClient({ orgSlug: 'demo', apiBase: 'https://api.example', fetch: (async () => Response.json({})) as unknown as typeof fetch })
    const observer = client as unknown as {
      startPageObservation(live: unknown): void
      stopPageObservation(): void
    }
    try {
      observer.startPageObservation({
        state: { status: 'connected' },
        sendContextualUpdate: (context: string) => updates.push(context),
      })
      expect(updates).toHaveLength(1)
      page.document.querySelector('[data-workforce-agent-rail]')!.textContent = 'new private transcript'
      await Bun.sleep(300)
      expect(updates).toHaveLength(1)
      page.document.querySelector('main p')!.textContent = 'Updated public fact.'
      await Bun.sleep(300)
      expect(updates).toHaveLength(2)
      expect(updates[1]).toContain('Updated public fact')
      href = 'https://site.example/new-route?token=secret'
      page.window.dispatchEvent(new page.window.Event('popstate'))
      await Bun.sleep(300)
      expect(updates).toHaveLength(3)
      expect(updates[2]).toContain('https://site.example/new-route')
      expect(JSON.stringify(updates)).not.toContain('private transcript')
      expect(JSON.stringify(updates)).not.toContain('token=secret')
    } finally {
      observer.stopPageObservation()
      client.destroy()
      for (const [key, old] of [['document', oldDocument], ['location', oldLocation], ['MutationObserver', oldObserver], ['window', oldWindow]] as const) {
        if (old) Object.defineProperty(globalThis, key, old)
        else Reflect.deleteProperty(globalThis, key)
      }
    }
  })
})

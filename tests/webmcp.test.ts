import { describe, expect, test } from 'bun:test'
import { createWebMcpBridge, publishRegistryToWebMcp, ClientToolRegistry, ConvincedClient, HOST_TOOL_PROTOCOL_VERSION,
  type WebMcpModelContext, type WebMcpRegisteredTool } from '../src'

function fixture() {
  const listeners = new Set<() => void>()
  const window = {}
  let calls = 0
  let listed: WebMcpRegisteredTool[] = [{ name: 'book', description: 'Book a slot', origin: 'https://test.example', window,
    inputSchema: JSON.stringify({ type: 'object', properties: { slot: { type: 'string' } }, required: ['slot'] }) }]
  const modelContext: WebMcpModelContext = {
    getTools: async () => listed,
    executeTool: async (_, input) => { calls++; return JSON.stringify({ confirmed: true, input: typeof input === 'string' ? JSON.parse(input) : input }) },
    addEventListener: (_, listener) => { listeners.add(listener) },
    removeEventListener: (_, listener) => { listeners.delete(listener) },
  }
  return { modelContext, calls: () => calls, change: () => listeners.forEach(listener => listener()),
    setTools: (tools: WebMcpRegisteredTool[]) => { listed = tools }, listed: () => listed }
}

describe('WebMCP generic bridge', () => {
  test('pages large catalogs without adding per-site agent tools', async () => {
    const f = fixture()
    f.setTools(Array.from({ length: 100 }, (_, i) => ({ ...f.listed()[0]!, name: `tool_${i}` })))
    const bridge = createWebMcpBridge({ modelContext: f.modelContext, origin: 'https://test.example', authorize: () => false })
    const first = await bridge.listTools()
    expect(first.total_count).toBe(100)
    expect(first.tools).toHaveLength(8)
    expect(first.next_offset).toBe(8)
    expect((await bridge.listTools(undefined, 96)).tools).toHaveLength(4)
    expect((await bridge.listTools(undefined, 96)).next_offset).toBeNull()
    expect(bridge.tools).toHaveLength(2)
    bridge.dispose()
  })

  test('deep website schemas survive the SDK observation depth limit', async () => {
    const f = fixture()
    let schema: unknown = { type: 'string' }
    for (let i = 0; i < 12; i++) schema = { type: 'object', properties: { child: schema } }
    f.setTools([{ ...f.listed()[0]!, inputSchema: JSON.stringify(schema) }])
    const bridge = createWebMcpBridge({ modelContext: f.modelContext, origin: 'https://test.example', authorize: () => false })
    const registry = new ClientToolRegistry(bridge.tools)
    const result = await registry.executeByName('host_webmcp_list_tools', { names: ['book'] }, {
      orgSlug: 'test', sessionId: null, turnId: 'schema', signal: new AbortController().signal,
    })
    expect(result.ok).toBe(true)
    const serialized = JSON.stringify(result)
    expect(serialized).toContain('input_schema_json')
    bridge.dispose()
  })

  test('discovers schemas and executes through two fixed tools with current Chrome serialization', async () => {
    const f = fixture()
    const bridge = createWebMcpBridge({ modelContext: f.modelContext, origin: 'https://test.example', authorize: () => true })
    expect(bridge.tools).toHaveLength(2)
    const catalog = await bridge.listTools()
    expect(catalog.tools[0]).not.toHaveProperty('inputSchema')
    const detailed = await bridge.listTools(['book'])
    expect(JSON.parse(detailed.tools[0]!.input_schema_json!)).toHaveProperty('type', 'object')
    expect(await bridge.executeTool(detailed.tools[0]!.id, { slot: '10:00' })).toEqual({ confirmed: true, input: { slot: '10:00' } })
    expect(f.calls()).toBe(1)
    bridge.dispose()
  })

  test('excludes foreign origins, rejects unknown handles and rechecks replaced tools', async () => {
    const f = fixture()
    f.setTools([...f.listed(), { ...f.listed()[0]!, origin: 'https://foreign.example' }])
    const bridge = createWebMcpBridge({ modelContext: f.modelContext, origin: 'https://test.example', authorize: () => true })
    const catalog = await bridge.listTools()
    expect(catalog.tools).toHaveLength(1)
    await expect(bridge.executeTool('invented', {})).rejects.toThrow('Unknown or stale')
    f.setTools([{ ...f.listed()[0]!, description: 'Changed action' }])
    await expect(bridge.executeTool(catalog.tools[0]!.id, {})).rejects.toThrow('changed')
    expect(f.calls()).toBe(0)
    bridge.dispose()
  })

  test('toolchange, disposal and cancellation prevent execution', async () => {
    const f = fixture()
    const bridge = createWebMcpBridge({ modelContext: f.modelContext, origin: 'https://test.example', authorize: () => true })
    const catalog = await bridge.listTools()
    f.change()
    await expect(bridge.executeTool(catalog.tools[0]!.id, {})).rejects.toThrow('stale')
    const fresh = await bridge.listTools()
    const cancelled = new AbortController(); cancelled.abort()
    await expect(bridge.executeTool(fresh.tools[0]!.id, {}, cancelled.signal)).rejects.toThrow()
    bridge.dispose()
    await expect(bridge.listTools()).rejects.toThrow('disposed')
    expect(f.calls()).toBe(0)
  })

  test('authorization is per underlying action and invalidation during approval fails closed', async () => {
    const f = fixture()
    let allowed = false
    const bridge = createWebMcpBridge({ modelContext: f.modelContext, origin: 'https://test.example', authorize: () => allowed })
    const { tools } = await bridge.listTools()
    await expect(bridge.executeTool(tools[0]!.id, {})).rejects.toThrow('denied')
    allowed = true
    await bridge.executeTool(tools[0]!.id, {})
    allowed = false
    await expect(bridge.executeTool(tools[0]!.id, {})).rejects.toThrow('denied')
    expect(f.calls()).toBe(1)
    bridge.dispose()
    const changing = createWebMcpBridge({ modelContext: f.modelContext, origin: 'https://test.example', authorize: async () => { f.change(); return true } })
    const fresh = await changing.listTools()
    await expect(changing.executeTool(fresh.tools[0]!.id, {})).rejects.toThrow('changed during authorization')
    expect(f.calls()).toBe(1)
    changing.dispose()
  })

  test('never retries a mutation after a browser error', async () => {
    const f = fixture()
    let calls = 0
    f.modelContext.executeTool = async () => { calls++; throw new Error('action failed after applying') }
    const bridge = createWebMcpBridge({ modelContext: f.modelContext, origin: 'https://test.example', authorize: () => true, argumentEncoding: 'object' })
    const { tools } = await bridge.listTools()
    await expect(bridge.executeTool(tools[0]!.id, {})).rejects.toThrow('action failed')
    expect(calls).toBe(1)
    bridge.dispose()
  })

  test('publisher preserves existing validation, authorization and lifecycle cleanup', async () => {
    const f = fixture()
    let registered: Parameters<NonNullable<WebMcpModelContext['registerTool']>>[0] | undefined
    let lifecycle: AbortSignal | undefined
    f.modelContext.registerTool = (tool, options) => { registered = tool; lifecycle = options?.signal }
    let called = 0
    const registry = new ClientToolRegistry([{
      version: HOST_TOOL_PROTOCOL_VERSION, name: 'host_open', description: 'Open an item',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      locality: 'host', effect: 'mutate', consent: 'session', timeoutMs: 1000,
      handler: async args => { called++; return args },
    }])
    const publisher = publishRegistryToWebMcp(registry, { modelContext: f.modelContext,
      execution: () => ({ orgSlug: 'test', sessionId: null, turnId: 'webmcp' }) })
    await publisher.ready
    await expect(registered!.execute({}, {})).rejects.toThrow('invalid_tool_arguments')
    await expect(registered!.execute({ id: 'a' }, {})).rejects.toThrow('consent_denied')
    expect(called).toBe(0)
    publisher.dispose()
    expect(lifecycle?.aborted).toBe(true)
  })

  test('client publishes its shared registry with one call', async () => {
    const f = fixture()
    let registered: Parameters<NonNullable<WebMcpModelContext['registerTool']>>[0] | undefined
    f.modelContext.registerTool = (tool) => { registered = tool }
    const contexts: Array<{ orgSlug: string; sessionId: string | null; surface?: string }> = []
    const tools = new ClientToolRegistry([{
      version: HOST_TOOL_PROTOCOL_VERSION,
      name: 'host_read_selection',
      description: 'Read the selected item',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      locality: 'host', effect: 'read', consent: 'none', timeoutMs: 1_000,
      handler: async (_args, context) => {
        contexts.push(context)
        return { selected: 'atlas' }
      },
    }])
    const client = new ConvincedClient({ orgSlug: 'test', tools })

    const publisher = client.publishToolsToWebMcp({ modelContext: f.modelContext })
    await publisher?.ready
    expect(await registered?.execute({}, {})).toEqual({ selected: 'atlas' })
    expect(contexts).toEqual([expect.objectContaining({
      orgSlug: 'test',
      sessionId: null,
      surface: 'webmcp',
    })])
    publisher?.dispose()
  })

  test('client applies its existing session consent policy to published WebMCP tools', async () => {
    const f = fixture()
    let registered: Parameters<NonNullable<WebMcpModelContext['registerTool']>>[0] | undefined
    f.modelContext.registerTool = (tool) => { registered = tool }
    let approvals = 0
    let executions = 0
    const client = new ConvincedClient({
      orgSlug: 'test',
      apiBase: 'https://mock.example',
      fetch: (async () => Response.json({
        sessionId: 'session_webmcp',
        sessionCapability: 'capability_webmcp',
        config: { orgName: 'Test', orgSlug: 'test', slidesEnabled: false, suggestedQuestions: [] },
      })) as unknown as typeof fetch,
      tools: [{
        version: HOST_TOOL_PROTOCOL_VERSION,
        name: 'host_open_record',
        description: 'Open a record',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        locality: 'host', effect: 'navigate', consent: 'session', timeoutMs: 1_000,
        handler: async ({ id }) => { executions++; return { opened: String(id) } },
      }],
      authorizeToolCall: ({ surface }) => {
        approvals++
        expect(surface).toBe('webmcp')
        return true
      },
    })
    await client.createSession()

    const publisher = client.publishToolsToWebMcp({ modelContext: f.modelContext })
    await publisher?.ready
    expect(await registered?.execute({ id: 'one' }, {})).toEqual({ opened: 'one' })
    expect(await registered?.execute({ id: 'two' }, {})).toEqual({ opened: 'two' })
    expect({ approvals, executions }).toEqual({ approvals: 1, executions: 2 })
    publisher?.dispose()
  })
})

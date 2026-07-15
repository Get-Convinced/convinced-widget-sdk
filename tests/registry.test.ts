import { describe, expect, test } from 'bun:test'
import {
  ClientToolRegistry,
  HOST_TOOL_PROTOCOL_VERSION,
  MAX_HOST_TOOL_CALLS_PER_TURN,
  MAX_HOST_TOOL_MANIFEST_BYTES,
  MAX_HOST_TOOL_SCHEMA_BYTES,
  MAX_HOST_TOOL_SCHEMA_DEPTH,
  type ClientTool,
  type JsonObject,
} from '../src'

describe('client tool manifest limits', () => {
  test('exports the canonical server-aligned bounds', () => {
    expect(MAX_HOST_TOOL_SCHEMA_BYTES).toBe(12 * 1024)
    expect(MAX_HOST_TOOL_SCHEMA_DEPTH).toBe(8)
    expect(MAX_HOST_TOOL_MANIFEST_BYTES).toBe(48 * 1024)
    expect(MAX_HOST_TOOL_CALLS_PER_TURN).toBe(64)
  })

  test('rejects an oversized individual schema', () => {
    const registry = new ClientToolRegistry()
    expect(() => registry.register(tool('host_large_schema', {
      type: 'object',
      description: 'x'.repeat(MAX_HOST_TOOL_SCHEMA_BYTES),
    }))).toThrow(`exceeds ${MAX_HOST_TOOL_SCHEMA_BYTES} bytes`)
  })

  test('rejects a schema deeper than the canonical JSON limit', () => {
    let schema: JsonObject = { type: 'object' }
    for (let index = 0; index < MAX_HOST_TOOL_SCHEMA_DEPTH; index++) {
      schema = { type: 'object', properties: { child: schema } }
    }
    const registry = new ClientToolRegistry()
    expect(() => registry.register(tool('host_deep_schema', schema))).toThrow(
      `exceeds maximum depth ${MAX_HOST_TOOL_SCHEMA_DEPTH}`,
    )
  })

  test('rejects schema keywords the server cannot enforce', () => {
    const registry = new ClientToolRegistry()
    expect(() => registry.register(tool('host_pattern_schema', {
      type: 'object',
      properties: { selector: { type: 'string', pattern: '^#' } },
      additionalProperties: false,
    }))).toThrow('pattern is not supported')
  })

  test('rejects aggregate manifest cost before registering the overflowing tool', () => {
    const registry = new ClientToolRegistry()
    const schema: JsonObject = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 11 }, (_, index) => [
          `field_${index}`,
          { type: 'string', description: 'x'.repeat(900) },
        ]),
      ),
    }
    for (let index = 1; index <= 4; index++) {
      registry.register(tool(`host_large_${index}`, schema, 'd'.repeat(900)))
    }
    expect(registry.definitions()).toHaveLength(4)
    expect(() => registry.register(tool('host_large_5', schema, 'd'.repeat(900)))).toThrow(
      `exceeds ${MAX_HOST_TOOL_MANIFEST_BYTES} bytes`,
    )
    expect(registry.definitions()).toHaveLength(4)
  })

  test('returns a bounded error before a deeply nested result reaches the server', async () => {
    let result: JsonObject = { value: true }
    for (let index = 0; index < MAX_HOST_TOOL_SCHEMA_DEPTH; index++) {
      result = { nested: result }
    }
    const deepTool: ClientTool = {
      ...tool('host_deep_result', {
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      handler: async () => result,
    }
    const registry = new ClientToolRegistry([deepTool])
    const execution = await registry.execute({
      version: HOST_TOOL_PROTOCOL_VERSION,
      id: 'call_deep_result',
      name: deepTool.name,
      args: {},
      locality: 'host',
      effect: deepTool.effect,
      consent: deepTool.consent,
    }, {
      orgSlug: 'demo',
      sessionId: 'session_123',
      turnId: 'turn_12345678',
      signal: new AbortController().signal,
    })

    expect(execution).toMatchObject({
      ok: false,
      error: { code: 'result_too_deep' },
    })
  })

  test('governs direct voice execution with schema validation and caller consent', async () => {
    let handlerCalls = 0
    let authorizationCalls = 0
    const registry = new ClientToolRegistry([{
      version: HOST_TOOL_PROTOCOL_VERSION,
      name: 'host_open_section',
      description: 'Open a named section in the host SPA.',
      inputSchema: {
        type: 'object',
        properties: { section: { type: 'string', minLength: 1, maxLength: 24 } },
        required: ['section'],
        additionalProperties: false,
      },
      locality: 'host',
      effect: 'navigate',
      consent: 'per_call',
      timeoutMs: 1_000,
      handler: async (arguments_, context) => {
        handlerCalls += 1
        expect(context.surface).toBe('voice')
        expect(context.conversationId).toBe('conv_123')
        return { opened: String(arguments_.section ?? '') }
      },
    }])
    const context = {
      orgSlug: 'demo',
      sessionId: 'session_123',
      turnId: 'voice_turn_123',
      surface: 'voice' as const,
      conversationId: 'conv_123',
      signal: new AbortController().signal,
    }

    const invalid = await registry.executeByName(
      'host_open_section',
      { section: '', extra: true },
      context,
      {
        authorize: () => {
          authorizationCalls += 1
          return true
        },
      },
    )
    expect(invalid).toMatchObject({ ok: false, error: { code: 'invalid_tool_arguments' } })
    expect(authorizationCalls).toBe(0)
    expect(handlerCalls).toBe(0)

    const denied = await registry.executeByName('host_open_section', { section: 'pricing' }, context)
    expect(denied).toMatchObject({ ok: false, error: { code: 'consent_denied' } })
    expect(handlerCalls).toBe(0)

    const allowed = await registry.executeByName(
      'host_open_section',
      JSON.stringify({ section: 'pricing' }),
      context,
      {
        authorize: ({ execution }) => {
          authorizationCalls += 1
          expect(execution.surface).toBe('voice')
          return true
        },
      },
    )
    expect(allowed).toMatchObject({ ok: true, result: { opened: 'pricing' } })
    expect(authorizationCalls).toBe(1)
    expect(handlerCalls).toBe(1)
  })
})

function tool(name: string, inputSchema: JsonObject, description = `Test tool ${name}`): ClientTool {
  return {
    version: HOST_TOOL_PROTOCOL_VERSION,
    name,
    description,
    inputSchema,
    locality: 'host',
    effect: 'read',
    consent: 'none',
    timeoutMs: 1_000,
    handler: async () => null,
  }
}

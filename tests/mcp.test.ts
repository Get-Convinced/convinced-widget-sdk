import { describe, expect, test } from 'bun:test'
import {
  createMcpTools,
  type CreateMcpToolsOptions,
  type ClientToolExecutionContext,
  type JsonObject,
} from '../src'

describe('MCP client adapter', () => {
  test('requires an explicit allow policy before discovering tools', async () => {
    let listed = false
    const client = {
      async listTools() {
        listed = true
        return { tools: [] }
      },
      async callTool() {
        return null
      },
    }

    await expect(createMcpTools(client, {} as CreateMcpToolsOptions)).rejects.toThrow('explicit allow list')
    expect(listed).toBe(false)
  })

  test('exposes only allowed tools and calls the supplied client', async () => {
    const calls: Array<{ name: string; arguments?: JsonObject }> = []
    const client = {
      async listTools() {
        return {
          tools: [
            {
              name: 'inventory.read',
              description: 'Read public inventory.',
              inputSchema: {
                type: 'object',
                properties: { sku: { type: 'string' } },
                required: ['sku'],
              },
            },
            { name: 'inventory.delete', description: 'Delete inventory.' },
          ],
        }
      },
      async callTool(request: { name: string; arguments?: JsonObject }) {
        calls.push(request)
        return { content: [{ type: 'text', text: '12 units' }] }
      },
    }
    const tools = await createMcpTools(client, {
      allow: ['inventory.read'],
      policy: { effect: 'read', consent: 'session', timeoutMs: 2_500 },
    })

    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      name: 'client_mcp_inventory_read',
      locality: 'host',
      effect: 'read',
      consent: 'session',
      timeoutMs: 2_500,
      constraints: {
        adapter: 'mcp',
        originalToolName: 'inventory.read',
        credentialsManagedByHost: true,
      },
    })
    const result = await tools[0]!.handler({ sku: 'RB-42' }, context())
    expect(result).toEqual({ content: [{ type: 'text', text: '12 units' }] })
    expect(calls).toEqual([{ name: 'inventory.read', arguments: { sku: 'RB-42' } }])
  })

  test('defaults unclassified MCP actions to mutate and per-call consent', async () => {
    const tools = await createMcpTools({
      async listTools() {
        return { tools: [{ name: 'Update CRM' }, { name: 'update-crm' }] }
      },
      async callTool() {
        return undefined
      },
    }, { allow: () => true })

    expect(tools.map((tool) => tool.name)).toEqual([
      'client_mcp_update_crm',
      'client_mcp_update_crm_2',
    ])
    expect(tools.every((tool) => tool.effect === 'mutate' && tool.consent === 'per_call')).toBe(true)
  })
})

function context(): ClientToolExecutionContext {
  return {
    orgSlug: 'demo',
    sessionId: 'session_123',
    turnId: 'turn_12345678',
    signal: new AbortController().signal,
  }
}

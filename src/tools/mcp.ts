import {
  HOST_TOOL_PROTOCOL_VERSION,
  MAX_HOST_TOOLS,
  type ClientTool,
  type JsonObject,
  type JsonValue,
  type ToolConsent,
  type ToolEffect,
} from '../types.js'

export interface McpToolLike {
  name: string
  description?: string
  inputSchema?: JsonObject
}

export interface McpClientLike {
  listTools(): Promise<{ tools: McpToolLike[] }>
  callTool(request: { name: string; arguments?: JsonObject }): Promise<unknown>
}

export interface McpToolPolicy {
  effect?: ToolEffect
  consent?: ToolConsent
  timeoutMs?: number
  constraints?: JsonObject
}

export interface CreateMcpToolsOptions {
  /** Defaults to client_mcp_. The final name is sanitized to the host-tool contract. */
  prefix?: string
  /** Required deny-by-default selection of MCP tools that may reach the model. */
  allow: string[] | ((tool: McpToolLike) => boolean)
  maxTools?: number
  policy?: McpToolPolicy | ((tool: McpToolLike) => McpToolPolicy)
  mapResult?: (result: unknown, tool: McpToolLike) => JsonValue
}

/**
 * Adapts a caller-supplied official MCP Client-like object into browser host
 * tools. The SDK never creates an MCP transport and never accepts credentials.
 */
export async function createMcpTools(
  client: McpClientLike,
  options: CreateMcpToolsOptions,
): Promise<ClientTool[]> {
  if (!options.allow) {
    throw new Error('createMcpTools requires an explicit allow list or allow predicate.')
  }
  const response = await client.listTools()
  const listed = Array.isArray(response.tools) ? response.tools : []
  const allowed = listed.filter((tool) => isAllowed(tool, options.allow))
  const maxTools = Math.min(MAX_HOST_TOOLS, Math.max(0, options.maxTools ?? MAX_HOST_TOOLS))
  const prefix = safePrefix(options.prefix ?? 'client_mcp_')
  const names = new Set<string>()

  return allowed.slice(0, maxTools).map((tool) => {
    if (!tool.name || typeof tool.name !== 'string') {
      throw new Error('MCP tools must have a non-empty name.')
    }
    const name = uniqueHostName(`${prefix}${safeNamePart(tool.name)}`, names)
    names.add(name)
    const policy = typeof options.policy === 'function' ? options.policy(tool) : options.policy ?? {}
    // MCP discovery does not carry a trustworthy read/write classification.
    // Unknown tools therefore default to the safest interactive policy.
    const effect = policy.effect ?? 'mutate'
    const consent = policy.consent ?? 'per_call'
    const timeoutMs = clampTimeout(policy.timeoutMs ?? 10_000)
    const inputSchema = normalizeInputSchema(tool.inputSchema)

    return {
      version: HOST_TOOL_PROTOCOL_VERSION,
      name,
      description:
        tool.description?.trim().slice(0, 1_000) || `Call the ${tool.name} MCP tool supplied by the host application.`,
      inputSchema,
      locality: 'host',
      effect,
      consent,
      timeoutMs,
      constraints: {
        adapter: 'mcp',
        originalToolName: tool.name,
        credentialsManagedByHost: true,
        ...(policy.constraints ?? {}),
      },
      handler: async (arguments_) => {
        const result = await client.callTool({ name: tool.name, arguments: arguments_ })
        return options.mapResult
          ? options.mapResult(result, tool)
          : normalizeMcpResult(result)
      },
    }
  })
}

function isAllowed(
  tool: McpToolLike,
  allow: CreateMcpToolsOptions['allow'],
): boolean {
  if (!allow) return true
  if (Array.isArray(allow)) return allow.includes(tool.name)
  return allow(tool)
}

function normalizeInputSchema(schema: JsonObject | undefined): JsonObject {
  if (schema?.type === 'object') return schema
  return { type: 'object', properties: {}, additionalProperties: true }
}

function normalizeMcpResult(value: unknown): JsonValue {
  if (value === undefined) return null
  const serialized = JSON.stringify(value)
  if (serialized === undefined) return null
  return JSON.parse(serialized) as JsonValue
}

function safePrefix(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_')
  const prefixed = safe.startsWith('client_') ? safe : `client_${safe}`
  return prefixed.endsWith('_') ? prefixed : `${prefixed}_`
}

function safeNamePart(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  return safe || 'tool'
}

function uniqueHostName(candidate: string, names: Set<string>): string {
  const base = candidate.slice(0, 64).replace(/_+$/g, '')
  if (!names.has(base)) return base
  for (let index = 2; index < 1_000; index++) {
    const suffix = `_${index}`
    const value = `${base.slice(0, 64 - suffix.length)}${suffix}`
    if (!names.has(value)) return value
  }
  throw new Error(`Unable to create a unique host-tool name for "${candidate}".`)
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return 10_000
  return Math.min(30_000, Math.max(100, Math.round(value)))
}

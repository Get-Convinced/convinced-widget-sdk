import { normalizeApiBase, readJsonResponse } from './transport.js'

/** Management access uses an authenticated admin session, never a widget token. */
export interface ConvincedAgentAdminOptions {
  orgSlug: string
  /** The Convinced SDK agent deployment to update. */
  agentId: string
  /** Convinced app origin, or an authenticated same-origin management proxy. */
  apiBase: string
  fetch?: typeof fetch
}

export interface AgentPrompt {
  source: 'convinced'
  agentId: string
  systemPrompt: string
  firstMessage: string
  revision: string
  updatedAt?: string
}

export interface UpdateAgentPromptInput {
  systemPrompt?: string
  /** Opening message. An empty string lets the visitor speak first. */
  firstMessage?: string
  /** Revision returned by getPrompt(); reload on a 409 conflict. */
  expectedRevision: string
}

/** Reads and persistently updates a Convinced SDK agent prompt. */
export class ConvincedAgentAdmin {
  private readonly endpoint: string
  private readonly agentId: string
  private readonly fetchImpl: typeof fetch

  constructor(options: ConvincedAgentAdminOptions) {
    for (const value of [options.orgSlug, options.agentId]) {
      if (!/^[a-zA-Z0-9_-]{1,140}$/.test(value)) {
        throw new Error('orgSlug and agentId must be non-empty identifiers.')
      }
    }
    const base = normalizeApiBase(options.apiBase)
    const url = new URL(base)
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('apiBase must not contain credentials, a query, or a fragment.')
    }
    this.agentId = options.agentId
    this.endpoint = `${base}/api/org/${options.orgSlug}/sdk-agents/${options.agentId}/prompt`
    this.fetchImpl = (options.fetch ?? globalThis.fetch).bind(globalThis)
  }

  getPrompt(options: { signal?: AbortSignal } = {}): Promise<AgentPrompt> {
    return this.request({ method: 'GET', ...options })
  }

  updatePrompt(input: UpdateAgentPromptInput, options: { signal?: AbortSignal } = {}): Promise<AgentPrompt> {
    if (input.systemPrompt === undefined && input.firstMessage === undefined) {
      throw new Error('Provide systemPrompt, firstMessage, or both.')
    }
    if (input.systemPrompt !== undefined && (typeof input.systemPrompt !== 'string' || !input.systemPrompt.trim() ||
        new TextEncoder().encode(input.systemPrompt).byteLength > 100_000)) {
      throw new Error('systemPrompt must contain between 1 and 100,000 UTF-8 bytes.')
    }
    if (input.firstMessage !== undefined && (typeof input.firstMessage !== 'string' ||
        new TextEncoder().encode(input.firstMessage).byteLength > 10_000)) {
      throw new Error('firstMessage must be a string of at most 10,000 UTF-8 bytes.')
    }
    if (!/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
      throw new Error('expectedRevision must come from getPrompt().')
    }
    return this.request({
      method: 'PATCH',
      ...options,
      // Whitelist fields so callers cannot change the provider agent or tools.
      body: JSON.stringify({
        systemPrompt: input.systemPrompt,
        firstMessage: input.firstMessage,
        expectedRevision: input.expectedRevision,
      }),
    })
  }

  private async request(init: RequestInit): Promise<AgentPrompt> {
    const result = await readJsonResponse<AgentPrompt>(await this.fetchImpl(this.endpoint, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    }))
    if (result.source !== 'convinced' || result.agentId !== this.agentId ||
        typeof result.systemPrompt !== 'string' || typeof result.firstMessage !== 'string' ||
        !/^[a-f0-9]{64}$/.test(result.revision)) {
      throw new Error('The management API returned an invalid agent prompt.')
    }
    return result
  }
}

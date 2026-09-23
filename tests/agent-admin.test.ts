import { describe, expect, test } from 'bun:test'
import { ConvincedAgentAdmin, ConvincedApiError } from '../src'

const current = {
  source: 'convinced', agentId: 'agent_enmovil', systemPrompt: 'Current prompt',
  firstMessage: 'Hello',
  revision: 'a'.repeat(64), branchId: 'branch_main', versionId: 'version_1', trafficPercentage: 100,
}

describe('ConvincedAgentAdmin', () => {
  test('reads the exact agent and saves through authenticated management, without a provider key', async () => {
    const requests: { url: string; init: RequestInit }[] = []
    const admin = new ConvincedAgentAdmin({
      orgSlug: 'enmovil', agentId: current.agentId, apiBase: 'https://app.example',
      fetch: (async (url, init = {}) => {
        requests.push({ url: String(url), init })
        return Response.json(init.method === 'PATCH' ? { ...current, systemPrompt: 'New prompt' } : current)
      }) as typeof fetch,
    })
    const prompt = await admin.getPrompt()
    const saved = await admin.updatePrompt({ systemPrompt: 'New prompt', expectedRevision: prompt.revision })
    expect(saved.systemPrompt).toBe('New prompt')
    expect(requests.map(r => r.url)).toEqual(Array(2).fill('https://app.example/api/org/enmovil/sdk-agents/agent_enmovil/prompt'))
    expect(requests[1]?.init).toMatchObject({ method: 'PATCH', credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({ systemPrompt: 'New prompt', expectedRevision: current.revision })
    expect(new Headers(requests[1]?.init.headers).has('xi-api-key')).toBe(false)
  })

  test.each([403, 409, 502])('preserves HTTP %i errors and never retries a save', async (status) => {
    let calls = 0
    const admin = new ConvincedAgentAdmin({
      orgSlug: 'enmovil', agentId: current.agentId, apiBase: 'https://app.example',
      fetch: (async (_url: RequestInfo | URL) => { calls++; return Response.json({ error: 'Failed', code: 'provider_update_unconfirmed', providerUpdate: 'unknown' }, { status }) }) as typeof fetch,
    })
    try {
      await admin.updatePrompt({ systemPrompt: 'New', expectedRevision: current.revision })
      throw new Error('Expected failure')
    } catch (cause) {
      expect(cause).toBeInstanceOf(ConvincedApiError)
      expect(cause).toMatchObject({ status, code: 'provider_update_unconfirmed', details: { providerUpdate: 'unknown' } })
    }
    expect(calls).toBe(1)
  })

  test('rejects invalid input before sending requests', () => {
    const admin = new ConvincedAgentAdmin({ orgSlug: 'enmovil', agentId: current.agentId, apiBase: 'https://app.example' })
    expect(() => admin.updatePrompt({ systemPrompt: ' ', expectedRevision: current.revision })).toThrow()
    expect(() => admin.updatePrompt({ systemPrompt: '🙂'.repeat(25_001), expectedRevision: current.revision })).toThrow()
    expect(() => admin.updatePrompt({ systemPrompt: 'New', expectedRevision: '' })).toThrow()
    expect(() => admin.updatePrompt({ expectedRevision: current.revision })).toThrow()
    expect(() => admin.updatePrompt({ firstMessage: '🙂'.repeat(2_501), expectedRevision: current.revision })).toThrow()
    expect(() => new ConvincedAgentAdmin({ orgSlug: '../another', agentId: current.agentId, apiBase: 'https://app.example' })).toThrow()
    expect(() => new ConvincedAgentAdmin({ orgSlug: 'enmovil', agentId: current.agentId, apiBase: 'https://secret@app.example' })).toThrow()
  })

  test.each([
    { firstMessage: 'A new opening' },
    { firstMessage: '' },
    { systemPrompt: 'New instructions', firstMessage: 'New opening' },
  ])('supports opening-message edits and combined edits', async changes => {
    const admin = new ConvincedAgentAdmin({
      orgSlug: 'enmovil', agentId: current.agentId, apiBase: 'https://app.example',
      fetch: (async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ ...changes, expectedRevision: current.revision })
        return Response.json({ ...current, ...changes })
      }) as typeof fetch,
    })
    expect(await admin.updatePrompt({ ...changes, expectedRevision: current.revision })).toMatchObject(changes)
  })

  test('rejects a mismatched agent response and forwards cancellation', async () => {
    const signal = new AbortController().signal
    const admin = new ConvincedAgentAdmin({
      orgSlug: 'enmovil', agentId: current.agentId, apiBase: 'https://app.example',
      fetch: (async (_url, init) => {
        expect(init?.signal).toBe(signal)
        return Response.json({ ...current, agentId: 'agent_other' })
      }) as typeof fetch,
    })
    await expect(admin.getPrompt({ signal })).rejects.toThrow('invalid agent prompt')
  })
})

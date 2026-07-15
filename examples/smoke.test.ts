import { afterAll, describe, expect, test } from 'bun:test'
import { createMockConversationFactory } from './shared/mock-elevenlabs.js'

const children: Bun.Subprocess[] = []

afterAll(() => {
  for (const child of children) child.kill()
})

describe('SDK browser examples', () => {
  for (const [name, script, page, orgSlug] of [
    ['voice-spa', 'voice-spa/server.ts', '/home?c=northstar-rollout&utm_campaign=voice-sdk', 'voice-spa-demo'],
    ['custom-brand', 'custom-brand/server.ts', '/?c=atelier-private-preview', 'custom-brand-demo'],
    ['managed-parity', 'managed-parity/server.ts', '/?c=lumen-expansion', 'managed-parity-demo'],
  ] as const) {
    test(`${name} serves a voice-first campaign session`, async () => {
      const port = 44_000 + Math.floor(Math.random() * 10_000)
      const child = Bun.spawn({
        cmd: [process.execPath, 'run', new URL(script, import.meta.url).pathname],
        env: {
          ...process.env,
          PORT: String(port),
          ...(name === 'voice-spa' ? { ELEVENLABS_AGENT_ID: 'agent_public_browser_test' } : {}),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      children.push(child)
      const base = `http://127.0.0.1:${port}`
      await waitForServer(base)

      const html = await fetch(`${base}${page}`).then((response) => response.text())
      expect(html).toContain('voice')
      expect(html).toContain('/sdk.js')

      const config = await fetch(`${base}/api/widget/${orgSlug}/config`).then((response) => response.json()) as Record<string, unknown>
      expect(config.voiceEnabled).toBe(true)
      expect(config.voiceMode).toBe('always_voice')
      if (name === 'voice-spa') expect(config.elevenLabsAgentId).toBe('agent_public_browser_test')

      const session = await fetch(`${base}/api/widget/${orgSlug}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ c: 'smoke-campaign', pageUrl: `${base}${page}` }),
      }).then((response) => response.json()) as Record<string, unknown>
      expect(typeof session.sessionId).toBe('string')
      expect(session.personalization).toBeTruthy()

      if (name === 'managed-parity') {
        expect((session.personalization as Record<string, unknown>).agentMode).toBe('campaign')
        const campaignIntel = await fetch(
          `${base}/api/widget/${orgSlug}/visitor-intel?sessionId=${encodeURIComponent(String(session.sessionId))}`,
        ).then((response) => response.json()) as Record<string, unknown>
        expect(campaignIntel).toMatchObject({ status: 'ready', companyName: 'Lumen Group' })
        const generic = await fetch(`${base}/api/widget/${orgSlug}/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageUrl: `${base}/` }),
        }).then((response) => response.json()) as Record<string, unknown>
        expect(generic).toMatchObject({
          knowledgeKit: null,
          recommendedSlides: [],
          recommendedVideos: [],
          personalization: {
            targetCompany: null,
            agentMode: 'inbound',
            firstMessage: '',
          },
        })
        expect(JSON.stringify(generic)).not.toContain('Lumen')
        const genericIntel = await fetch(
          `${base}/api/widget/${orgSlug}/visitor-intel?sessionId=${encodeURIComponent(String(generic.sessionId))}`,
        ).then((response) => response.json()) as Record<string, unknown>
        expect(genericIntel).toEqual({ status: 'unavailable' })
      }

      const app = await fetch(`${base}/app.js`).then((response) => response.text())
      expect(app).toContain('ConvincedVoiceController')
      expect(app).toContain('ClientToolRegistry')
    }, 10_000)
  }

  test('mock ElevenLabs factory invokes real client-tool callback names in order', async () => {
    const calls: string[] = []
    const factory = createMockConversationFactory()
    const conversation = await factory({
      textOnly: false,
      clientTools: Object.fromEntries(
        ['host_navigate', 'host_get_page_context', 'host_scroll_to', 'host_highlight']
          .map((name) => [name, async () => { calls.push(name); return JSON.stringify({ ok: true }) }]),
      ),
    })

    conversation.sendUserMessage('Please show me pricing.')
    await waitUntil(() => calls.length === 4)
    expect(calls).toEqual([
      'host_navigate',
      'host_get_page_context',
      'host_scroll_to',
      'host_highlight',
    ])
    await conversation.endSession()
  })

  test('mock ElevenLabs factory routes extensions through host_extension_call', async () => {
    const calls: Array<{ name: string; parameters: unknown }> = []
    const factory = createMockConversationFactory()
    const conversation = await factory({
      textOnly: false,
      clientTools: {
        host_extension_call: async (parameters) => {
          calls.push({ name: 'host_extension_call', parameters })
          return JSON.stringify({ ok: true, result: 'available' })
        },
      },
    })
    conversation.sendUserMessage('Check enterprise inventory through MCP.')
    await waitUntil(() => calls.length === 1)
    expect(calls).toEqual([{
      name: 'host_extension_call',
      parameters: {
        name: 'client_mcp_inventory_lookup',
        arguments_json: '{"sku":"enterprise"}',
      },
    }])
    await conversation.endSession()
  })
})

async function waitForServer(base: string): Promise<void> {
  await waitUntil(async () => {
    try {
      const response = await fetch(base)
      // Drain the readiness response before issuing the real request. Leaving
      // it unread can poison a pooled Bun connection and surface as a
      // Malformed_HTTP_Response in fast CI runners.
      await response.arrayBuffer()
      return response.status < 500
    } catch {
      return false
    }
  }, 5_000)
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await Bun.sleep(20)
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms.`)
}

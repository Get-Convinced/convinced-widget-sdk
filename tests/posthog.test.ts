import { describe, expect, test } from 'bun:test'
import { ConvincedClient, createPostHogBridge } from '../src'

function json(data: unknown): Response {
  return Response.json(data)
}

describe('ConvincedPostHogBridge', () => {
  test('correlates analytics with the signed Convinced session and identifies by opaque visitor id', async () => {
    const contextBodies: Array<Record<string, unknown>> = []
    const posthogCalls: Array<[string, ...unknown[]]> = []
    const client = new ConvincedClient({
      orgSlug: 'arcwell',
      apiBase: 'https://app.example',
      fetch: (async (input, init) => {
        const url = String(input)
        if (url.endsWith('/config')) return json({ orgSlug: 'arcwell', orgName: 'Arcwell' })
        if (url.endsWith('/session')) return json({
          sessionId: 'conv-session-1',
          sessionCapability: 'capability',
          config: { orgSlug: 'arcwell', orgName: 'Arcwell' },
        })
        if (url.endsWith('/identity')) return json({ visitorId: 'visitor_opaque_42' })
        if (url.endsWith('/context')) {
          contextBodies.push(JSON.parse(String(init?.body)))
          return json({ ok: true })
        }
        throw new Error(`Unexpected request ${url}`)
      }) as typeof fetch,
    })
    await client.initialize({ loadMedia: false })
    const posthog = {
      capture: (...args: unknown[]) => posthogCalls.push(['capture', ...args]),
      identify: (...args: unknown[]) => posthogCalls.push(['identify', ...args]),
      register_for_session: (...args: unknown[]) => posthogCalls.push(['register', ...args]),
      startSessionRecording: (...args: unknown[]) => posthogCalls.push(['record', ...args]),
      stopSessionRecording: () => posthogCalls.push(['stop']),
      get_session_id: () => 'ph-session-7',
      get_session_replay_url: () => 'https://us.posthog.com/project/1/replay/ph-session-7',
    }
    const bridge = createPostHogBridge({ client, posthog })

    const link = await bridge.start()
    await client.captureIdentity({
      email: 'private@example.com',
      name: 'Private Person',
      company: 'Arcwell',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(link).toEqual({
      convincedSessionId: 'conv-session-1',
      posthogSessionId: 'ph-session-7',
      replayUrl: 'https://us.posthog.com/project/1/replay/ph-session-7',
    })
    expect(posthogCalls).toContainEqual([
      'register',
      { convinced_session_id: 'conv-session-1', convinced_org_slug: 'arcwell' },
    ])
    expect(posthogCalls).toContainEqual(['identify', 'visitor_opaque_42', {}])
    expect(JSON.stringify(posthogCalls)).not.toContain('private@example.com')
    expect(JSON.stringify(posthogCalls)).not.toContain('Private Person')
    expect(contextBodies.some((body) => JSON.stringify(body).includes('analytics_session_linked'))).toBe(true)
    bridge.stop()
  })

  test('rejects unsafe replay URLs and persists bounded lifecycle events', async () => {
    const contextBodies: Array<Record<string, unknown>> = []
    const captured: string[] = []
    const client = new ConvincedClient({
      orgSlug: 'arcwell',
      apiBase: 'https://app.example',
      fetch: (async (input, init) => {
        const url = String(input)
        if (url.endsWith('/config')) return json({ orgSlug: 'arcwell', orgName: 'Arcwell' })
        if (url.endsWith('/session')) return json({
          sessionId: 'conv-session-2',
          sessionCapability: 'capability',
          config: { orgSlug: 'arcwell', orgName: 'Arcwell' },
        })
        if (url.endsWith('/context')) {
          contextBodies.push(JSON.parse(String(init?.body)))
          return json({ ok: true })
        }
        throw new Error(`Unexpected request ${url}`)
      }) as typeof fetch,
    })
    await client.initialize({ loadMedia: false })
    const bridge = createPostHogBridge({
      client,
      posthog: {
        capture: (name) => captured.push(name),
        identify: () => undefined,
        get_session_id: () => 'ph_2',
        get_session_replay_url: () => 'javascript:alert(1)',
      },
    })

    expect((await bridge.start()).replayUrl).toBeNull()
    await bridge.capture('page_navigated', { route: '/security' })
    expect(captured).toContain('widget.page_navigated')
    expect(contextBodies.some((body) => JSON.stringify(body).includes('page_navigated'))).toBe(true)
  })

  test('captures demo lifecycle without sending lead PII to PostHog', async () => {
    const posthogCalls: Array<[string, ...unknown[]]> = []
    const client = new ConvincedClient({
      orgSlug: 'arcwell',
      apiBase: 'https://app.example',
      fetch: (async (input) => {
        const url = String(input)
        if (url.endsWith('/config')) return json({ orgSlug: 'arcwell', orgName: 'Arcwell' })
        if (url.endsWith('/session')) return json({
          sessionId: 'conv-session-demo',
          sessionCapability: 'capability',
          config: { orgSlug: 'arcwell', orgName: 'Arcwell' },
        })
        if (url.endsWith('/demo-request')) return json({
          ok: true,
          alreadySubmitted: false,
          submittedAt: '2026-07-15T00:00:00.000Z',
          visitorId: 'visitor_demo_42',
        })
        throw new Error(`Unexpected request ${url}`)
      }) as typeof fetch,
    })
    await client.initialize({ loadMedia: false })
    const bridge = createPostHogBridge({
      client,
      posthog: {
        capture: (...args: unknown[]) => posthogCalls.push(['capture', ...args]),
        identify: (...args: unknown[]) => posthogCalls.push(['identify', ...args]),
      },
      persistCorrelation: false,
    })
    await bridge.start()

    await client.submitDemoRequest({
      email: 'private@example.com',
      name: 'Private Person',
      company: 'Private Company',
    })

    expect(posthogCalls).toContainEqual([
      'capture',
      'widget.demo_submitted',
      {
        orgSlug: 'arcwell',
        sessionId: 'conv-session-demo',
        submittedAt: '2026-07-15T00:00:00.000Z',
        alreadySubmitted: false,
        identityLinked: true,
        hasCompany: true,
        hasPhone: false,
      },
      { send_instantly: true },
    ])
    expect(posthogCalls).toContainEqual(['identify', 'visitor_demo_42', {}])
    expect(JSON.stringify(posthogCalls)).not.toContain('private@example.com')
    expect(JSON.stringify(posthogCalls)).not.toContain('Private Person')
    expect(JSON.stringify(posthogCalls)).not.toContain('Private Company')
    bridge.stop()
  })
})

import { describe, expect, test } from 'bun:test'

const example = new URL('.', import.meta.url)

describe('real organization lab demo-request contract', () => {
  test('shows request correlation without claiming a calendar booking', async () => {
    const html = await Bun.file(new URL('index.html', example)).text()
    expect(html).toContain('id="demo-request-status"')
    expect(html).toContain('None · no time booked')
    expect(html).toContain('it does not schedule a calendar meeting')
    expect(html).toContain('id="demo-e2e"')
  })

  test('observes the public SDK event and leaves PostHog capture to the consented bridge', async () => {
    const app = await Bun.file(new URL('app.js', example)).text()
    expect(app).toContain("client.on('demo_request'")
    expect(app).toContain("'widget.demo_opened'")
    expect(app).toContain("'widget.demo_submitted'")
    expect(app).toContain("'widget.demo_failed'")
    expect(app).not.toMatch(/(?:analytics|posthog)\.capture\(['"](?:widget\.)?demo_/)
    expect(app).not.toContain("client.on('demo_request_submitted'")
    expect(app).not.toContain("client.on('demo_request_failed'")
    expect(app).toContain('PostHog SDK emission')
    expect(app).toContain('posthogEmittedEvents')
    expect(app).not.toContain('PostHog did not receive')
  })

  test('requires identity and an idempotent backend replay in the live check', async () => {
    const app = await Bun.file(new URL('app.js', example)).text()
    expect(app).toContain('client.state.identity?.email')
    expect(app).toContain('replay?.alreadySubmitted !== true')
    expect(app).toContain('safeOpaqueId(replay.requestId) !== requestId')
    expect(app).toContain('safeOpaqueId(replay.visitorId) !== visitorId')
    expect(app).toContain("PERSISTENT_DEMO_REQUEST_CONTEXT = 'Visitor opened the persistent demo request.'")
    expect(app).toContain('context: PERSISTENT_DEMO_REQUEST_CONTEXT')
    expect(app).not.toContain("context: 'Real organization lab durability replay.'")
  })

  test('ends through the managed widget so voice transcript and shown slides are persisted', async () => {
    const app = await Bun.file(new URL('app.js', example)).text()
    expect(app).toContain('await widget.endSession()')
    expect(app).not.toContain('await widget.endVoice().catch')
    expect(app).toContain('voiceConnected && !wasVoiceConnected')
  })
})

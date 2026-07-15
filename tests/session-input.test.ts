import { describe, expect, test } from 'bun:test'
import {
  browserSessionInput,
  ConvincedClient,
  forgetBrowserVisitorKey,
  normalizeCampaignToken,
  resolveWidgetSessionAttribution,
} from '../src'

describe('loader-compatible browser attribution', () => {
  test('uses explicit campaign, then c query, path, and utm_campaign', () => {
    const source = 'https://acme.example/for/path-campaign/?c=query-campaign&utm_campaign=utm-campaign'

    expect(resolveWidgetSessionAttribution(source, { c: 'Explicit Campaign!' }).c)
      .toBe('explicit-campaign')
    expect(resolveWidgetSessionAttribution(source).c).toBe('query-campaign')
    expect(resolveWidgetSessionAttribution(
      'https://acme.example/for/Path-Campaign/?utm_campaign=utm-campaign',
    ).c).toBe('path-campaign')
    expect(resolveWidgetSessionAttribution(
      'https://acme.example/pricing?utm_campaign=Summer%20Launch%202026',
    ).c).toBe('summer-launch-2026')
  })

  test('uses explicit pid, then pid query, then cid query', () => {
    const source = 'https://acme.example/?pid=pid-query&cid=cid-query'
    expect(resolveWidgetSessionAttribution(source, { pid: 'pid-explicit' }).pid)
      .toBe('pid-explicit')
    expect(resolveWidgetSessionAttribution(source).pid).toBe('pid-query')
    expect(resolveWidgetSessionAttribution('https://acme.example/?cid=cid-query').pid)
      .toBe('cid-query')
  })

  test('builds the complete browser session input and keeps UTM fields', () => {
    const input = browserSessionInput({
      url: 'https://acme.example/for/campaign/?utm_source=linkedin&utm_medium=paid&utm_campaign=ignored',
      pageTitle: 'Acme pricing',
      referrer: 'https://linkedin.com/',
      fingerprint: 'fingerprint-1',
    })

    expect(input).toEqual({
      pageUrl: 'https://acme.example/for/campaign/',
      pageTitle: 'Acme pricing',
      referrer: 'https://linkedin.com/',
      fingerprint: 'fingerprint-1',
      c: 'campaign',
      utmData: {
        utm_source: 'linkedin',
        utm_medium: 'paid',
        utm_campaign: 'ignored',
      },
    })
  })

  test('removes page/referrer secrets while retaining explicit attribution fields', () => {
    const input = browserSessionInput({
      url: 'https://acme.example/pricing?token=super-secret&c=enterprise&utm_source=linkedin#email=buyer@example.com',
      referrer: 'https://search.example/results?q=buyer@example.com&token=private#fragment',
      pid: 'person-link-123',
    })

    expect(input).toMatchObject({
      pageUrl: 'https://acme.example/pricing',
      referrer: 'https://search.example/results',
      c: 'enterprise',
      pid: 'person-link-123',
      utmData: { utm_source: 'linkedin' },
    })
    expect(JSON.stringify(input)).not.toContain('super-secret')
    expect(JSON.stringify(input)).not.toContain('buyer@example.com')
    expect(JSON.stringify(input)).not.toContain('token=private')
  })

  test('normalizes campaign tokens exactly like the managed loader', () => {
    expect(normalizeCampaignToken('  ACME___Logistics / FY26  ')).toBe('acme-logistics-fy26')
    expect(normalizeCampaignToken('x'.repeat(80))).toHaveLength(64)
  })

  test('bounds attribution values and drops secret-like UTM data', () => {
    const attribution = resolveWidgetSessionAttribution(
      `https://acme.example/?pid=${'p'.repeat(300)}&utm_source=${'s'.repeat(300)}&utm_content=buyer%40example.com&utm_term=reset%20token%20secret`,
    )

    expect(attribution.pid).toHaveLength(128)
    expect(attribution.utmData).toEqual({ utm_source: 's'.repeat(256) })
    expect(JSON.stringify(attribution)).not.toContain('buyer@example.com')
    expect(JSON.stringify(attribution)).not.toContain('reset token secret')
  })

  test('reuses one opaque org-scoped visitor key across clients and sends it with identity', async () => {
    const memory = new Map<string, string>()
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => memory.set(key, value),
        removeItem: (key: string) => memory.delete(key),
      },
    })
    const sessionFingerprints: string[] = []
    const identityFingerprints: string[] = []
    const makeClient = () => new ConvincedClient({
      orgSlug: 'acme',
      apiBase: 'https://app.example',
      fetch: (async (input, init) => {
        const url = String(input)
        if (url.endsWith('/config')) return Response.json({ orgSlug: 'acme', orgName: 'Acme' })
        if (url.endsWith('/session')) {
          sessionFingerprints.push(JSON.parse(String(init?.body)).fingerprint)
          return Response.json({
            sessionId: `session-${sessionFingerprints.length}`,
            sessionCapability: 'capability',
            config: { orgSlug: 'acme', orgName: 'Acme' },
          })
        }
        if (url.endsWith('/identity')) {
          identityFingerprints.push(JSON.parse(String(init?.body)).fingerprint)
          return Response.json({ visitorId: 'visitor-1' })
        }
        if (url.endsWith('/context')) return Response.json({ ok: true })
        throw new Error(`Unexpected request ${url}`)
      }) as typeof fetch,
    })

    try {
      const first = makeClient()
      await first.initialize({ loadMedia: false })
      await first.captureIdentity({ email: 'buyer@example.com' })
      const second = makeClient()
      await second.initialize({ loadMedia: false })

      expect(sessionFingerprints).toHaveLength(2)
      expect(sessionFingerprints[0]).toBe(sessionFingerprints[1])
      expect(identityFingerprints).toEqual([sessionFingerprints[0]!])
      const opaqueRecord = JSON.parse(memory.get('convinced-sdk-visitor-acme-v1') ?? '{}') as Record<string, unknown>
      expect(Object.keys(opaqueRecord).sort()).toEqual(['createdAt', 'id', 'lastSeenAt'])
      expect(JSON.stringify(opaqueRecord)).not.toContain('buyer@example.com')
      memory.set('convinced-visitor-acme', JSON.stringify({
        name: 'Legacy Buyer',
        email: 'legacy@example.com',
        lastTopic: 'private topic',
      }))
      forgetBrowserVisitorKey('acme')
      expect(memory.has('convinced-sdk-visitor-acme-v1')).toBe(false)
      expect(memory.has('convinced-visitor-acme')).toBe(false)
      const third = makeClient()
      await third.initialize({ loadMedia: false })
      expect(sessionFingerprints[2]).not.toBe(sessionFingerprints[0])
    } finally {
      if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
      else delete (globalThis as { localStorage?: unknown }).localStorage
    }
  })
})

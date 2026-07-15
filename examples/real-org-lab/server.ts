import { randomUUID } from 'node:crypto'
import { safeConvincedApiBase, safeHttpsBase } from './server-security'

const port = boundedPort(process.env.PORT, 4184)
const hostname = '127.0.0.1'
const orgSlug = safeOrgSlug(process.env.CONVINCED_ORG_SLUG || 'convinced')
const campaignToken = safeToken(process.env.CONVINCED_CAMPAIGN_TOKEN || 'acme-robotics')
const convincedApiBase = safeConvincedApiBase(
  process.env.CONVINCED_API_BASE || 'https://app.getconvinced.ai',
)
const dashboardBase = safeHttpsBase(
  process.env.CONVINCED_DASHBOARD_BASE || 'https://app.getconvinced.ai',
)
const elevenLabsAgentId = safeAgentId(process.env.SAMPLE_ELEVENLABS_AGENT_ID || '')
const elevenLabsApiKey = (
  process.env.ELEVEN_API_KEY || process.env.ELEVENLABS_API_KEY || ''
).trim()
const posthogKey = (
  process.env.SAMPLE_POSTHOG_KEY || process.env.NEXT_PUBLIC_POSTHOG_KEY || ''
).trim()
const slideFilename = safeFilename(
  process.env.SAMPLE_SLIDE_FILENAME ||
    'What-If-Every-AE-Had-Your-Best-SE-Beside-Thempage11774799789656.png',
)
const widgetStyleHash = await builtWidgetStyleHash()

const browserOrigin = `http://localhost:${port}`
const alternateBrowserOrigin = `http://127.0.0.1:${port}`
const sessionBindings = new Map<string, SessionBinding>()
const voiceQuotas = new Map<string, { count: number; resetAt: number }>()

interface SessionBinding {
  sessionId: string
  capability?: string
  createdAt: number
  voiceTokensIssued: number
}

const server = Bun.serve({
  hostname,
  port,
  async fetch(request) {
    if (!safeHost(request.headers.get('host'), port)) {
      return response('Misdirected request', 421)
    }
    cleanExpiredBindings()
    const url = new URL(request.url)

    if (request.method === 'GET' && routePage(url.pathname)) return asset('index.html')
    if (request.method === 'GET' && url.pathname === '/styles.css') return asset('styles.css')
    if (request.method === 'GET' && url.pathname === '/app.js') return asset('app.js')
    if (request.method === 'GET' && url.pathname === '/sdk.js') {
      return file(
        new URL('../../dist/convinced-widget.global.js', import.meta.url),
        'text/javascript; charset=utf-8',
      )
    }
    if (request.method === 'GET' && url.pathname === '/posthog.js') {
      return file(
        new URL('../../node_modules/posthog-js/dist/array.js', import.meta.url),
        'text/javascript; charset=utf-8',
      )
    }
    if (request.method === 'GET' && url.pathname === '/api/runtime-config') {
      return json({
        orgSlug,
        campaignToken,
        posthogKey: publicPostHogKey(posthogKey),
        posthogApiHost: '/ingest',
        dashboardBase,
        slideFilename,
        voiceAvailable: Boolean(elevenLabsAgentId && elevenLabsApiKey),
      })
    }
    if (request.method === 'POST' && url.pathname === '/api/voice-token') {
      return issueVoiceToken(request)
    }
    if (url.pathname.startsWith('/ingest/')) return proxyPostHog(request, url)
    if (url.pathname.startsWith(`/api/widget/${orgSlug}/`)) {
      return proxyConvinced(request, url)
    }
    return response('Not found', 404)
  },
})

console.log(`Real Convinced SDK lab: ${browserOrigin}/overview?c=${campaignToken}`)
console.log(`Organization: ${orgSlug} · campaign: ${campaignToken}`)
console.log(`ElevenLabs private-token path: ${elevenLabsAgentId && elevenLabsApiKey ? 'ready' : 'disabled (set SAMPLE_ELEVENLABS_AGENT_ID + ELEVEN_API_KEY)'}`)
console.log(`PostHog: ${publicPostHogKey(posthogKey) ? 'ready' : 'disabled (set NEXT_PUBLIC_POSTHOG_KEY)'}`)

async function issueVoiceToken(request: Request): Promise<Response> {
  if (!sameOriginMutation(request)) return json({ error: 'Same-origin request required' }, 403)
  if (!elevenLabsAgentId || !elevenLabsApiKey) {
    return json({ error: 'Private ElevenLabs test agent is not configured' }, 503)
  }
  const cookieId = cookie(request, 'convinced_lab')
  const binding = cookieId ? sessionBindings.get(cookieId) : null
  const capability = request.headers.get('x-widget-session-capability')?.trim() || ''
  // The BFF selects both the Convinced session and ElevenLabs agent. The
  // browser cannot substitute either identifier: it only presents the
  // HttpOnly SameSite binding created from the upstream session response.
  // Newer Convinced deployments add a second session-capability check.
  if (
    !binding ||
    (binding.capability && binding.capability !== capability)
  ) {
    return json({ error: 'Voice request is not bound to this Convinced session' }, 403)
  }
  if (Date.now() - binding.createdAt > 2 * 60 * 60 * 1_000) {
    return json({ error: 'Convinced session binding expired' }, 401)
  }
  if (binding.voiceTokensIssued >= 6 || limited(`voice:${binding.sessionId}`, 4, 60_000)) {
    return json({ error: 'Voice token quota exceeded' }, 429, { 'Retry-After': '60' })
  }

  const upstreamUrl = new URL('https://api.elevenlabs.io/v1/convai/conversation/token')
  upstreamUrl.searchParams.set('agent_id', elevenLabsAgentId)
  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { 'xi-api-key': elevenLabsApiKey },
      signal: AbortSignal.timeout(8_000),
    })
  } catch {
    return json({ error: 'Voice provider unavailable' }, 502)
  }
  const raw = await upstream.text()
  if (!upstream.ok) return json({ error: 'Voice provider rejected the request' }, 502)
  let token = ''
  try {
    const parsed = JSON.parse(raw) as { token?: unknown }
    token = typeof parsed.token === 'string' ? parsed.token.trim() : ''
  } catch {
    token = ''
  }
  if (!token || token.length > 8_192) return json({ error: 'Voice provider returned an invalid token' }, 502)
  binding.voiceTokensIssued += 1
  return json({ conversationToken: token, connectionType: 'webrtc' })
}

async function proxyConvinced(request: Request, url: URL): Promise<Response> {
  if (!['GET', 'POST', 'PATCH', 'OPTIONS'].includes(request.method)) {
    return json({ error: 'Method not allowed' }, 405)
  }
  const target = new URL(`${url.pathname}${url.search}`, convincedApiBase)
  const headers = new Headers()
  for (const name of ['content-type', 'accept', 'x-widget-token', 'x-widget-session-capability']) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  // The dogfood deployment explicitly allows localhost. Forward a fixed,
  // known origin rather than trusting a caller-controlled header.
  headers.set('origin', browserOrigin)
  const body = request.method === 'GET' || request.method === 'OPTIONS'
    ? undefined
    : await boundedBody(request, 512 * 1024)
  if (body instanceof Response) return body

  let upstream: Response
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    return json({ error: 'Convinced API unavailable' }, 502)
  }
  const responseBody = await upstream.arrayBuffer()
  const responseHeaders = new Headers({
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Cache-Control': 'no-store',
  })

  if (
    upstream.ok &&
    request.method === 'POST' &&
    url.pathname === `/api/widget/${orgSlug}/session`
  ) {
    try {
      const data = JSON.parse(new TextDecoder().decode(responseBody)) as Record<string, unknown>
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
      const capability = typeof data.sessionCapability === 'string' ? data.sessionCapability : ''
      if (sessionId) {
        const existingCookie = cookie(request, 'convinced_lab')
        const cookieId = existingCookie && /^[A-Za-z0-9_-]{20,128}$/.test(existingCookie)
          ? existingCookie
          : randomUUID().replace(/-/g, '')
        sessionBindings.set(cookieId, {
          sessionId,
          ...(capability ? { capability } : {}),
          createdAt: Date.now(),
          voiceTokensIssued: 0,
        })
        responseHeaders.append(
          'Set-Cookie',
          `convinced_lab=${cookieId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200`,
        )
      }
    } catch {
      // Return the provider response unchanged; the browser will show its error.
    }
  }
  return new Response(responseBody, { status: upstream.status, headers: responseHeaders })
}

async function proxyPostHog(request: Request, url: URL): Promise<Response> {
  if (!publicPostHogKey(posthogKey)) return response('PostHog is not configured', 404)
  if (!['GET', 'POST'].includes(request.method)) return response('Method not allowed', 405)
  const target = new URL(
    `${url.pathname.replace(/^\/ingest/, '') || '/'}${url.search}`,
    'https://us.i.posthog.com',
  )
  const headers = new Headers()
  for (const name of ['content-type', 'accept', 'content-encoding']) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  const body = request.method === 'POST' ? await boundedBytes(request, 2 * 1024 * 1024) : undefined
  if (body instanceof Response) return body
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    })
    const responseHeaders = new Headers({
      'Cache-Control': 'no-store',
      'Content-Type': upstream.headers.get('content-type') || 'text/plain; charset=utf-8',
    })
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: responseHeaders,
    })
  } catch {
    return response('PostHog unavailable', 502)
  }
}

function asset(name: string): Response {
  const type = name.endsWith('.css')
    ? 'text/css; charset=utf-8'
    : name.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : 'text/html; charset=utf-8'
  return file(new URL(`./${name}`, import.meta.url), type)
}

function file(url: URL, contentType: string): Response {
  return new Response(Bun.file(url), {
    headers: securityHeaders({ 'Content-Type': contentType }),
  })
}

function json(
  value: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: securityHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    }),
  })
}

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }),
  })
}

function securityHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self' blob:",
      `style-src 'self' '${widgetStyleHash}'`,
      "img-src 'self' data: https:",
      "media-src 'self' blob: https:",
      "frame-src https://www.youtube-nocookie.com",
      "connect-src 'self' https://api.elevenlabs.io wss://api.elevenlabs.io https://livekit.rtc.elevenlabs.io wss://livekit.rtc.elevenlabs.io https://*.livekit.cloud wss://*.livekit.cloud",
      "worker-src 'self' blob:",
    ].join('; '),
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...extra,
  })
}

async function builtWidgetStyleHash(): Promise<string> {
  const value = (
    await Bun.file(new URL('../../dist/managed-widget-style.sha256', import.meta.url)).text()
  ).trim()
  if (!/^sha256-[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error('Build the SDK before running the real-org lab; its CSP style hash is missing or invalid.')
  }
  return value
}

function routePage(pathname: string): boolean {
  return pathname === '/' || ['/overview', '/proof', '/security'].includes(pathname)
}

function sameOriginMutation(request: Request): boolean {
  const origin = request.headers.get('origin')
  const fetchSite = request.headers.get('sec-fetch-site')
  return (
    (origin === browserOrigin || origin === alternateBrowserOrigin) &&
    (!fetchSite || fetchSite === 'same-origin')
  )
}

function cookie(request: Request, name: string): string | null {
  const match = request.headers.get('cookie')
    ?.split(';')
    .map(value => value.trim())
    .find(value => value.startsWith(`${name}=`))
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null
}

function limited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const current = voiceQuotas.get(key)
  if (!current || current.resetAt <= now) {
    voiceQuotas.set(key, { count: 1, resetAt: now + windowMs })
    return false
  }
  current.count += 1
  return current.count > limit
}

function cleanExpiredBindings(): void {
  const cutoff = Date.now() - 2 * 60 * 60 * 1_000
  for (const [key, value] of sessionBindings) {
    if (value.createdAt < cutoff) sessionBindings.delete(key)
  }
  if (sessionBindings.size > 100) {
    for (const key of [...sessionBindings.keys()].slice(0, sessionBindings.size - 100)) {
      sessionBindings.delete(key)
    }
  }
}

async function boundedJson(request: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  const body = await boundedBody(request, maxBytes)
  if (body instanceof Response || !body) return null
  try {
    const parsed: unknown = JSON.parse(body)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

async function boundedBody(request: Request, maxBytes: number): Promise<string | undefined | Response> {
  const declared = Number(request.headers.get('content-length') || 0)
  if (Number.isFinite(declared) && declared > maxBytes) return json({ error: 'Request too large' }, 413)
  const value = await request.text()
  if (new TextEncoder().encode(value).byteLength > maxBytes) return json({ error: 'Request too large' }, 413)
  return value || undefined
}

async function boundedBytes(request: Request, maxBytes: number): Promise<ArrayBuffer | undefined | Response> {
  const declared = Number(request.headers.get('content-length') || 0)
  if (Number.isFinite(declared) && declared > maxBytes) return json({ error: 'Request too large' }, 413)
  const value = await request.arrayBuffer()
  if (value.byteLength > maxBytes) return json({ error: 'Request too large' }, 413)
  return value.byteLength > 0 ? value : undefined
}

function publicPostHogKey(value: string): string {
  return /^phc_[A-Za-z0-9_-]{10,256}$/.test(value) ? value : ''
}

function safeHost(value: string | null, expectedPort: number): boolean {
  return value === `localhost:${expectedPort}` || value === `127.0.0.1:${expectedPort}`
}

function boundedPort(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535 ? parsed : fallback
}

function safeOrgSlug(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(value)) throw new Error('Invalid CONVINCED_ORG_SLUG')
  return value
}

function safeToken(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new Error('Invalid CONVINCED_CAMPAIGN_TOKEN')
  return value
}

function safeAgentId(value: string): string {
  return /^(?:agent|seng)_[A-Za-z0-9_-]{8,128}$/.test(value) ? value : ''
}

function safeFilename(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/.test(value)) throw new Error('Invalid SAMPLE_SLIDE_FILENAME')
  return value
}

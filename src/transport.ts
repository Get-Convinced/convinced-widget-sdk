import type { WidgetSseEvent } from './types.js'

export const SSE_DONE = Symbol('convinced_sse_done')

export class ConvincedApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly details?: unknown

  constructor(message: string, options: { status: number; code?: string; details?: unknown }) {
    super(message)
    this.name = 'ConvincedApiError'
    this.status = options.status
    if (options.code) this.code = options.code
    if (options.details !== undefined) this.details = options.details
  }
}

export async function readJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) throw await apiError(response)
  return (await response.json()) as T
}

export async function apiError(response: Response): Promise<ConvincedApiError> {
  let details: unknown
  let message = `Convinced API request failed with HTTP ${response.status}.`
  let code: string | undefined
  try {
    details = await response.clone().json()
    if (details && typeof details === 'object') {
      const record = details as Record<string, unknown>
      if (typeof record.error === 'string' && record.error) message = record.error
      if (typeof record.code === 'string') code = record.code
    }
  } catch {
    const text = await response.text().catch(() => '')
    if (text.trim()) message = text.trim().slice(0, 1_000)
  }
  return new ConvincedApiError(message, {
    status: response.status,
    ...(code ? { code } : {}),
    ...(details !== undefined ? { details } : {}),
  })
}

export async function* iterateSse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<WidgetSseEvent | typeof SSE_DONE> {
  if (!response.ok) throw await apiError(response)
  if (!response.body) {
    throw new ConvincedApiError('Convinced API returned an empty SSE response.', {
      status: response.status,
      code: 'empty_stream',
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const abort = () => void reader.cancel(signal?.reason).catch(() => undefined)
  signal?.addEventListener('abort', abort, { once: true })

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal?.aborted) throw signal.reason ?? new Error('SSE stream was cancelled.')
      buffer += decoder.decode(value, { stream: true })
      buffer = normalizeSseNewlines(buffer)
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = parseSseBlock(block)
        if (event) yield event
        boundary = buffer.indexOf('\n\n')
      }
    }
    buffer += decoder.decode()
    buffer = normalizeSseNewlines(buffer, true)
    if (signal?.aborted) throw signal.reason ?? new Error('SSE stream was cancelled.')
    const event = parseSseBlock(buffer)
    if (event) yield event
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

function normalizeSseNewlines(value: string, final = false): string {
  const preserveTrailingCarriageReturn = !final && value.endsWith('\r')
  const source = preserveTrailingCarriageReturn ? value.slice(0, -1) : value
  return source.replace(/\r\n/g, '\n').replace(/\r/g, '\n') +
    (preserveTrailingCarriageReturn ? '\r' : '')
}

export function parseSseBlock(block: string): WidgetSseEvent | typeof SSE_DONE | null {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n')
  if (!data) return null
  if (data === '[DONE]') return SSE_DONE
  try {
    const parsed: unknown = JSON.parse(data)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      return { type: 'error', error: 'SSE data was not an object.', code: 'invalid_sse_event' }
    }
    return parsed as WidgetSseEvent
  } catch {
    return { type: 'error', error: 'SSE data was not valid JSON.', code: 'invalid_sse_json' }
  }
}

export function normalizeApiBase(value: string): string {
  const base = removeTrailingSlashes(value)
  const url = new URL(base)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('apiBase must use http or https.')
  }
  return url.href.endsWith('/') ? url.href.slice(0, -1) : url.href
}

function removeTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1
  return end === value.length ? value : value.slice(0, end)
}

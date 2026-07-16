import { describe, expect, test } from 'bun:test'
import { iterateSse, normalizeApiBase, SSE_DONE } from '../src/transport'

describe('SSE transport', () => {
  test('normalizes CRLF framing split across network chunks', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      'data: {"delta":"Hello"}\r',
      '\n\r',
      '\ndata: [DONE]\r',
      '\n\r',
      '\n',
    ]
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } })

    const events: unknown[] = []
    for await (const event of iterateSse(response)) events.push(event)

    expect(events).toEqual([{ delta: 'Hello' }, SSE_DONE])
  })

  test('normalizes API base trailing slashes without changing URL semantics', () => {
    expect(normalizeApiBase('https://api.example.test///')).toBe('https://api.example.test')
    expect(normalizeApiBase('https://api.example.test/v1///')).toBe('https://api.example.test/v1')
    expect(normalizeApiBase('http://localhost:3000/')).toBe('http://localhost:3000')
  })

  test('handles long slash runs within a fixed time bound', () => {
    const nonTrailingRun = `https://api.example.test/${'/'.repeat(100_000)}x`
    const trailingRun = `https://api.example.test/v1${'/'.repeat(100_000)}`
    const startedAt = performance.now()

    expect(normalizeApiBase(nonTrailingRun)).toBe(new URL(nonTrailingRun).href)
    expect(normalizeApiBase(trailingRun)).toBe('https://api.example.test/v1')
    expect(performance.now() - startedAt).toBeLessThan(1_000)
  }, 2_000)
})

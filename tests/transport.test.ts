import { describe, expect, test } from 'bun:test'
import { iterateSse, SSE_DONE } from '../src/transport'

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
})

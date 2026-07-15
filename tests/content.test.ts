import { describe, expect, test } from 'bun:test'
import {
  parseAssistantContent,
  stripAssistantDirectives,
  toSafeVideoEmbedUrl,
} from '../src'

describe('assistant media content', () => {
  test('resolves slide metadata and privacy-enhanced video embeds', () => {
    const text = [
      'Here is the warehouse workflow.',
      '[SLIDE:warehouse-automation.svg]',
      '[VIDEO:https://www.youtube.com/watch?v=M7lc1UVf-VE|See it in motion]',
      '[PILLS:Show pricing|Book a demo]',
    ].join('\n')
    const content = parseAssistantContent(text, {
      slides: [{
        key: 'slides/warehouse-automation.svg',
        filename: 'warehouse-automation.svg',
        url: 'https://cdn.example/warehouse-automation.svg',
      }],
      slideMetadata: {
        'warehouse-automation.svg': {
          filename: 'warehouse-automation.svg',
          title: 'Warehouse automation',
          description: 'How robots move products safely.',
          keyPoints: ['Faster picking'],
        },
      },
      videos: [{
        url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
        title: 'Warehouse walkthrough',
      }],
    })

    expect(content).toEqual([
      { type: 'text', text: 'Here is the warehouse workflow.' },
      expect.objectContaining({
        type: 'slide',
        filename: 'warehouse-automation.svg',
        url: 'https://cdn.example/warehouse-automation.svg',
        title: 'Warehouse automation',
      }),
      {
        type: 'video',
        url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
        title: 'See it in motion',
        embedUrl: 'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE',
      },
    ])
    expect(stripAssistantDirectives(text)).toBe('Here is the warehouse workflow.')
  })

  test('does not turn arbitrary hosts or non-http schemes into embeds', () => {
    expect(toSafeVideoEmbedUrl('https://video.example/demo')).toBeUndefined()
    expect(toSafeVideoEmbedUrl('javascript:alert(1)')).toBeUndefined()
    expect(toSafeVideoEmbedUrl('https://vimeo.com/12345678')).toBe(
      'https://player.vimeo.com/video/12345678',
    )
  })

  test('keeps unknown model video directives inert until the URL is initialized', () => {
    const unknown = parseAssistantContent(
      'I can explain it here. [VIDEO:https://www.youtube.com/watch?v=unknown1234|Unknown]',
      { videos: [{ url: 'https://www.youtube.com/watch?v=approved123', title: 'Approved' }] },
    )
    expect(unknown).toEqual([{ type: 'text', text: 'I can explain it here.' }])

    const notInitialized = parseAssistantContent(
      '[VIDEO:https://www.youtube.com/watch?v=approved123|Approved]',
    )
    expect(notInitialized).toEqual([{ type: 'text', text: '' }])
  })
})

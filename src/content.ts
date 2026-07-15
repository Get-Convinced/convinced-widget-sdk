import type {
  MessageContentPart,
  RecommendedVideo,
  SlideContentPart,
  SlideItem,
  SlideMetadata,
  VideoContentPart,
} from './types.js'

export interface ParseAssistantContentOptions {
  slides?: SlideItem[]
  slideMetadata?: Record<string, SlideMetadata>
  /** Exact video URLs initialized by the host or recommended by Convinced. */
  videos?: Array<Pick<RecommendedVideo, 'url' | 'title'>>
}

const MEDIA_DIRECTIVE = /\[(SLIDE|VIDEO):([^\]]+)\]/gi
const PILLS_DIRECTIVE = /\[PILLS:[^\]]*\]/gi

export function parseAssistantContent(
  text: string,
  options: ParseAssistantContentOptions = {},
): MessageContentPart[] {
  const parts: MessageContentPart[] = []
  let cursor = 0

  for (const match of text.matchAll(MEDIA_DIRECTIVE)) {
    const index = match.index ?? 0
    pushText(parts, text.slice(cursor, index).replace(PILLS_DIRECTIVE, ''))
    const kind = match[1]?.toUpperCase()
    const body = match[2]?.trim() ?? ''
    if (kind === 'SLIDE' && body) parts.push(resolveSlide(body, options))
    if (kind === 'VIDEO' && body) {
      const video = resolveVideo(body, options)
      if (video) parts.push(video)
    }
    cursor = index + match[0].length
  }

  pushText(parts, text.slice(cursor).replace(PILLS_DIRECTIVE, ''))
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }]
}

export function stripAssistantDirectives(text: string): string {
  return text.replace(MEDIA_DIRECTIVE, '').replace(PILLS_DIRECTIVE, '').replace(/\n{3,}/g, '\n\n').trim()
}

export function toSafeVideoEmbedUrl(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined

  const host = url.hostname.replace(/^www\./, '').toLowerCase()
  if (host === 'youtu.be') {
    const id = safeVideoId(url.pathname.slice(1))
    return id ? `https://www.youtube-nocookie.com/embed/${id}` : undefined
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    const pathId = url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1]
    const id = safeVideoId(pathId ?? url.searchParams.get('v') ?? '')
    return id ? `https://www.youtube-nocookie.com/embed/${id}` : undefined
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = url.pathname.match(/(?:video\/)?(\d+)/)?.[1]
    return id ? `https://player.vimeo.com/video/${id}` : undefined
  }
  return undefined
}

export function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function resolveSlide(
  filename: string,
  options: ParseAssistantContentOptions,
): SlideContentPart {
  const normalized = filename.toLowerCase()
  const slide = options.slides?.find(
    (item) => item.filename.toLowerCase() === normalized || item.key.toLowerCase().endsWith(`/${normalized}`),
  )
  const metadataEntry = Object.entries(options.slideMetadata ?? {}).find(
    ([key, metadata]) => key.toLowerCase() === normalized || metadata.filename.toLowerCase() === normalized,
  )?.[1]
  return {
    type: 'slide',
    filename,
    ...(slide && isSafeHttpUrl(slide.url) ? { url: slide.url } : {}),
    ...(metadataEntry?.title ? { title: metadataEntry.title } : {}),
    ...(metadataEntry ? { metadata: metadataEntry } : {}),
  }
}

function resolveVideo(
  body: string,
  options: ParseAssistantContentOptions,
): VideoContentPart | undefined {
  const separator = body.indexOf('|')
  const url = (separator >= 0 ? body.slice(0, separator) : body).trim()
  const title = separator >= 0 ? body.slice(separator + 1).trim() : ''
  const initialized = options.videos?.find((video) => video.url.trim() === url)
  if (!initialized) return undefined
  const embedUrl = toSafeVideoEmbedUrl(url)
  return {
    type: 'video',
    url,
    ...(title || initialized.title ? { title: title || initialized.title } : {}),
    ...(embedUrl ? { embedUrl } : {}),
  }
}

function pushText(parts: MessageContentPart[], value: string): void {
  const text = value.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim()
  if (text) parts.push({ type: 'text', text })
}

function safeVideoId(value: string): string | undefined {
  return /^[A-Za-z0-9_-]{6,64}$/.test(value) ? value : undefined
}

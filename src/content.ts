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

const SLIDE_DIRECTIVE = 1
const VIDEO_DIRECTIVE = 2
const PILLS_DIRECTIVE = 4
const MEDIA_DIRECTIVES = SLIDE_DIRECTIVE | VIDEO_DIRECTIVE
const DIRECTIVE_PREFIX_LENGTH = '[SLIDE:'.length

type AssistantDirectiveKind = 'SLIDE' | 'VIDEO' | 'PILLS'

interface AssistantDirectiveMatch {
  body: string
  end: number
  index: number
  kind: AssistantDirectiveKind
}

export function parseAssistantContent(
  text: string,
  options: ParseAssistantContentOptions = {},
): MessageContentPart[] {
  const parts: MessageContentPart[] = []
  let cursor = 0

  let match = findAssistantDirective(text, cursor, MEDIA_DIRECTIVES)
  while (match) {
    pushText(parts, removeAssistantDirectives(text.slice(cursor, match.index), PILLS_DIRECTIVE))
    const body = match.body.trim()
    const kind = match.kind
    if (kind === 'SLIDE' && body) parts.push(resolveSlide(body, options))
    if (kind === 'VIDEO' && body) {
      const video = resolveVideo(body, options)
      if (video) parts.push(video)
    }
    cursor = match.end
    match = findAssistantDirective(text, cursor, MEDIA_DIRECTIVES)
  }

  pushText(parts, removeAssistantDirectives(text.slice(cursor), PILLS_DIRECTIVE))
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }]
}

export function stripAssistantDirectives(text: string): string {
  return removeAssistantDirectives(
    removeAssistantDirectives(text, MEDIA_DIRECTIVES),
    PILLS_DIRECTIVE,
  ).replace(/\n{3,}/g, '\n\n').trim()
}

/** Internal helper shared with the managed widget's return-topic sanitizer. */
export function stripVideoAndPillsDirectives(text: string): string {
  return removeAssistantDirectives(
    removeAssistantDirectives(text, VIDEO_DIRECTIVE),
    PILLS_DIRECTIVE,
  )
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

function findAssistantDirective(
  text: string,
  fromIndex: number,
  allowedKinds: number,
): AssistantDirectiveMatch | null {
  let index = text.indexOf('[', fromIndex)
  while (index >= 0) {
    const kind = directiveKindAt(text, index, allowedKinds)
    if (kind) {
      const bodyStart = index + DIRECTIVE_PREFIX_LENGTH
      const closingBracket = text.indexOf(']', bodyStart)
      // With no later closing bracket, no directive at a later opening bracket
      // can match either. Returning immediately keeps malformed input linear.
      if (closingBracket < 0) return null
      if (kind === 'PILLS' || closingBracket > bodyStart) {
        return {
          body: text.slice(bodyStart, closingBracket),
          end: closingBracket + 1,
          index,
          kind,
        }
      }
    }
    index = text.indexOf('[', index + 1)
  }
  return null
}

function directiveKindAt(
  text: string,
  index: number,
  allowedKinds: number,
): AssistantDirectiveKind | null {
  if ((allowedKinds & SLIDE_DIRECTIVE) !== 0 && hasAsciiPrefix(text, index, '[SLIDE:')) return 'SLIDE'
  if ((allowedKinds & VIDEO_DIRECTIVE) !== 0 && hasAsciiPrefix(text, index, '[VIDEO:')) return 'VIDEO'
  if ((allowedKinds & PILLS_DIRECTIVE) !== 0 && hasAsciiPrefix(text, index, '[PILLS:')) return 'PILLS'
  return null
}

function hasAsciiPrefix(text: string, index: number, upperCasePrefix: string): boolean {
  if (index + upperCasePrefix.length > text.length) return false
  for (let offset = 0; offset < upperCasePrefix.length; offset += 1) {
    const expected = upperCasePrefix.charCodeAt(offset)
    const actual = text.charCodeAt(index + offset)
    if (actual === expected) continue
    if (expected < 65 || expected > 90 || actual !== expected + 32) return false
  }
  return true
}

function removeAssistantDirectives(text: string, allowedKinds: number): string {
  let match = findAssistantDirective(text, 0, allowedKinds)
  if (!match) return text
  const parts: string[] = []
  let cursor = 0
  while (match) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index))
    cursor = match.end
    match = findAssistantDirective(text, cursor, allowedKinds)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts.join('')
}

function safeVideoId(value: string): string | undefined {
  return /^[A-Za-z0-9_-]{6,64}$/.test(value) ? value : undefined
}

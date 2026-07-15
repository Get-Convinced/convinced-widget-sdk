export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject {
  [key: string]: JsonValue
}

/** JSON Schema shape accepted by the Convinced runtime and MCP tool lists. */
export interface JsonSchema {
  type?: string | string[]
  title?: string
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema | JsonSchema[]
  enum?: JsonValue[]
  const?: JsonValue
  default?: JsonValue
  examples?: JsonValue[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  minProperties?: number
  maxProperties?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
}

export const HOST_TOOL_PROTOCOL_VERSION = 1 as const
export const MAX_HOST_TOOLS = 16
export const MAX_HOST_TOOL_CALLS_PER_TURN = 64
export const MAX_HOST_TOOL_SCHEMA_BYTES = 12 * 1024
export const MAX_HOST_TOOL_SCHEMA_DEPTH = 8
export const MAX_HOST_TOOL_MANIFEST_BYTES = 48 * 1024
export const MAX_HOST_TOOL_ARGS_BYTES = 16 * 1024
export const MAX_HOST_TOOL_RESULT_BYTES = 32 * 1024
export const MAX_HOST_TOOL_TIMEOUT_MS = 30_000
export type ToolEffect = 'read' | 'navigate' | 'mutate'
export type ToolConsent = 'none' | 'session' | 'per_call'

export interface ClientToolDefinition {
  version: typeof HOST_TOOL_PROTOCOL_VERSION
  name: string
  description: string
  inputSchema: JsonObject
  locality: 'host'
  effect: ToolEffect
  consent: ToolConsent
  timeoutMs: number
  constraints?: JsonObject
}

export interface ClientToolCall {
  version: typeof HOST_TOOL_PROTOCOL_VERSION
  id: string
  name: string
  args: JsonObject
  locality: 'host'
  effect: ToolEffect
  consent: ToolConsent
}

export interface ClientToolExecutionContext {
  orgSlug: string
  sessionId: string | null
  turnId: string
  /** Defaults to chat for direct registry callers created before voice support. */
  surface?: 'chat' | 'voice'
  conversationId?: string
  signal: AbortSignal
}

export interface ClientToolExecutionAuthorizationContext {
  call: ClientToolCall
  tool: ClientToolDefinition
  execution: ClientToolExecutionContext
}

export type ClientToolExecutionAuthorizer = (
  context: ClientToolExecutionAuthorizationContext,
) => boolean | Promise<boolean>

export interface ExecuteClientToolOptions {
  /** Required for tools whose manifest declares session or per_call consent. */
  authorize?: ClientToolExecutionAuthorizer
  callId?: string
}

export type ClientToolHandler = (
  arguments_: JsonObject,
  context: ClientToolExecutionContext,
) => JsonValue | undefined | Promise<JsonValue | undefined>

export interface ClientTool extends ClientToolDefinition {
  handler: ClientToolHandler
}

export interface ClientToolResult {
  version: typeof HOST_TOOL_PROTOCOL_VERSION
  callId: string
  name: string
  args: JsonObject
  ok: boolean
  result?: JsonValue
  error?: {
    code: string
    message: string
  }
  durationMs: number
}

export type WidgetVoiceMode =
  | 'text_only'
  | 'smart_gate'
  | 'email_gate'
  | 'always_voice'
  | 'voice_only'
  | (string & {})

export type WidgetLauncherStyle =
  | 'morph-pill'
  | 'bottom-drawer'
  | 'brutalist'
  | 'gradient-ring'
  | 'slide-over'
  | 'spotlight'
  | 'ticker'
  | (string & {})

export type WidgetLauncherPosition =
  | 'bottom-right'
  | 'bottom-left'
  | 'bottom-center'
  | (string & {})

export type WidgetV2Theme =
  | 'frost-glass'
  | 'brutalist'
  | 'gradient-ring'
  | 'slide-over'
  | 'drawer'
  | 'spotlight'
  | (string & {})

export type WidgetTickerLuxStyle = 'marquee' | 'lacquer' | 'mercury' | 'velvet'

export interface WidgetPill {
  id: string
  label: string
  color: string
  productName: string | null
  prompt: string
  order: number
}

export interface WidgetWelcomeCardConfig {
  tagline: string
  stats: Array<{ value: string; label: string }>
  customerLogos: Array<{ name: string; logoUrl: string }>
  ctaText?: string
  backgroundColor?: string
}

export interface WidgetPillsConfig {
  enabled: boolean
  warmupExchanges: number
  emailGateMessage: string
  customerProof?: string
  companyIntro?: string
  introSlide?: string
  initialPillCount?: number
  welcomeCard?: WidgetWelcomeCardConfig
  pills: WidgetPill[]
}

export interface WidgetEngagementTriggers {
  emailCapture?: {
    enabled: boolean
    mode: string
    pillText: string
    afterMessages?: number
  }
  resourceOffer?: { enabled: boolean; mode: string; pillText: string }
  meetingCta?: { enabled: boolean; mode: string; pillText: string }
}

export interface WidgetConfig {
  orgName: string
  orgSlug: string
  primaryColor?: string
  accentColor?: string
  position?: string
  greetingMessage?: string
  agentName?: string
  agentAvatarUrl?: string | null
  voiceEnabled?: boolean
  voiceMode?: WidgetVoiceMode
  voiceProvider?: string
  elevenLabsAgentId?: string | null
  slidesEnabled?: boolean
  videosEnabled?: boolean
  identityCaptureAfterExchanges?: number
  suggestedQuestions?: string[]
  language?: string
  testMode?: boolean
  meetingCtaText?: string | null
  meetingCtaUrl?: string | null
  agentTitle?: string | null
  welcomeMessage?: string | null
  spotlightEnabled?: boolean
  engagementTriggers?: WidgetEngagementTriggers | null
  widgetTheme?: string
  widgetDarkMode?: boolean
  allowModeToggle?: boolean
  showPoweredBy?: boolean
  voiceCtaText?: string | null
  pillsConfig?: WidgetPillsConfig | null
  usePromptOverride?: boolean
  agentSystemPrompt?: string | null
  agentDiscoveryQuestions?: string[]
  widgetVersion?: 'v1' | 'v2'
  launcherStyle?: WidgetLauncherStyle
  launcherPosition?: WidgetLauncherPosition
  launcherCta?: string
  v2Theme?: WidgetV2Theme
  expandEnabled?: boolean
  expandGlowColor?: string
  firstMessageEnabled?: boolean
  firstMessageText?: string
  returnVisitorEnabled?: boolean
  returnVisitorDays?: number
  returnVisitorGreeting?: string
  launcherCallout?: string
  launcherCalloutEnabled?: boolean
  launcherPulseEnabled?: boolean
  tickerColor?: string | null
  tickerLines?: string[]
  tickerLuxStyle?: WidgetTickerLuxStyle
  tickerBarEnabled?: boolean
  tickerIntroEnabled?: boolean
  [key: string]: unknown
}

export interface WidgetSessionInput {
  pageUrl?: string
  pageTitle?: string
  fingerprint?: string
  referrer?: string
  pid?: string
  c?: string
  utmData?: Record<string, string>
  utm?: Record<string, string>
}

export interface BrowserSessionInputOptions {
  /** Explicit campaign token. Mirrors the loader's data-c override. */
  c?: string
  /** Explicit personalized-link id. Mirrors the loader's data-pid override. */
  pid?: string
  url?: string | URL
  pageTitle?: string
  referrer?: string
  fingerprint?: string
}

export interface WidgetSessionAttribution {
  c?: string
  pid?: string
  utmData?: Record<string, string>
}

export interface RecommendedSlide {
  filename: string
  title: string
  slideType: string
  score: number
}

export type VideoTimelineQualityStatus = 'usable' | 'partial' | 'failed' | 'needs_review'

export interface VideoTimelineItem {
  timestampMs: number
  timestampLabel: string
  scene: string
  action?: string
  visibleText?: string
  moduleHints?: string[]
  featureHints?: string[]
  confidence?: number
}

export interface RecommendedVideo {
  title: string
  url: string
  sourceType: 'youtube_video' | string
  sourceLabel?: string
  sourceHash?: string
  timestampMs?: number
  score?: number
  storyTitle?: string
  summary?: string
  qualityStatus?: VideoTimelineQualityStatus
  timeline?: VideoTimelineItem[]
  snippets?: string[]
}

export interface WidgetCaseStudyRecommendation {
  customer: string
  reason: string
}

export interface WidgetPersonalization {
  targetCompany: string | null
  targetPerson: string | null
  targetRole: string | null
  targetIndustry: string | null
  agentMode: string
  promptAdditions: string
  firstMessage: string
  knowledgeKit: string | null
  recommendedSlides: RecommendedSlide[]
  talkTrack: string[]
  challenges: string[]
  caseStudies: WidgetCaseStudyRecommendation[]
  repNotes?: string | null
}

export interface WidgetReturnVisitor {
  previousTopics: string[]
  lastSessionDate: string
}

export interface WidgetSessionResponse {
  sessionId: string
  /** Opaque short-lived capability required for session-scoped browser writes. */
  sessionCapability?: string
  variant?: string | null
  knowledgeKit?: string | null
  recommendedSlides?: RecommendedSlide[] | null
  recommendedVideos?: RecommendedVideo[] | null
  returnVisitor?: WidgetReturnVisitor | null
  personalization?: WidgetPersonalization | null
  config: WidgetConfig
}

export interface VisitorIdentity {
  email?: string
  name?: string
  company?: string
  industry?: string
  role?: string
  phone?: string
  title?: string
}

export interface IdentityInput extends VisitorIdentity {
  email: string
  fingerprint?: string
  resourceType?: string
  resourceLabel?: string
}

export interface IdentityResponse {
  visitorId: string
  previousTopics?: string[]
  derivedCompany?: string | null
  enrichmentStatus?: string
}

export type WidgetVisitorIntelStatus =
  | 'unknown'
  | 'queued'
  | 'ready'
  | 'failed'
  | 'unavailable'

export interface WidgetVisitorIntelSource {
  title: string
  url: string
}

export interface WidgetVisitorIntelResponse {
  status: WidgetVisitorIntelStatus
  companyName?: string
  industry?: string
  hq?: string
  employeeRange?: string
  recentNews?: string
  summary?: string
  sources?: WidgetVisitorIntelSource[]
  error?: string
  updatedAt?: number
}

export interface WidgetVoiceCredentialResponse {
  conversationToken: string
  connectionType: 'webrtc'
}

export interface WidgetDemoRequestInput {
  name: string
  email: string
  phone?: string
  company?: string
  context?: string
}

export interface WidgetDemoRequestResponse {
  ok: true
  /** The session already owns a request; adapters must not re-bind current form PII. */
  alreadySubmitted?: boolean
  submittedAt?: string
  /** Optional durable request identifier returned by newer backends. */
  requestId?: string
  /** Opaque visitor id returned when the demo endpoint linked identity atomically. */
  visitorId?: string
}

export type WidgetDemoRequestFailureStage = 'submission' | 'identity_sync'

/**
 * Privacy-safe lifecycle emitted for managed and custom demo-request UIs.
 * The submitted name, email, company, and phone values are deliberately absent.
 */
export type WidgetDemoRequestLifecycleEvent =
  | {
      status: 'opened'
      surface: string
    }
  | {
      status: 'submitted'
      requestId?: string
      submittedAt?: string
      alreadySubmitted: boolean
      identityLinked: boolean
      hasCompany: boolean
      hasPhone: boolean
    }
  | {
      status: 'failed'
      stage: WidgetDemoRequestFailureStage
      errorCode: string
      hasCompany: boolean
      hasPhone: boolean
    }

export interface SlideItem {
  key: string
  filename: string
  url: string
}

export interface SlideRegion {
  label: string
  position: string
  description: string
  speakingCue: string
}

export interface SlideMetadata {
  filename: string
  title: string
  description: string
  keyPoints: string[]
  slideType?: string
  tags?: string[]
  features?: string[]
  painPoints?: string[]
  module?: string
  caseStudy?: string
  industry?: string
  regions?: SlideRegion[]
  layoutType?: string
  slideIntent?: Record<string, unknown>
}

export interface ChatHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface TextContentPart {
  type: 'text'
  text: string
}

export interface SlideContentPart {
  type: 'slide'
  filename: string
  url?: string
  title?: string
  metadata?: SlideMetadata
}

export interface VideoContentPart {
  type: 'video'
  url: string
  title?: string
  embedUrl?: string
}

export type MessageContentPart = TextContentPart | SlideContentPart | VideoContentPart

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  content: MessageContentPart[]
  createdAt: number
}

export type ClientStatus =
  | 'idle'
  | 'initializing'
  | 'ready'
  | 'streaming'
  | 'paused'
  | 'error'
  | 'destroyed'

export interface ConvincedClientState {
  status: ClientStatus
  config: WidgetConfig | null
  session: WidgetSessionResponse | null
  slides: SlideItem[]
  slideMetadata: Record<string, SlideMetadata>
  messages: ChatMessage[]
  identity: VisitorIdentity | null
  error: Error | null
  activeTurnId: string | null
}

export interface WidgetBehaviorEvent {
  name: string
  props?: JsonObject
  ts: number
}

export interface UpdateSessionContextInput {
  events?: WidgetBehaviorEvent[]
  identity?: VisitorIdentity | null
  voiceUpgrade?: boolean
  voiceUpgradeAt?: string
  pillsMessages?: Array<{ role: 'user' | 'assistant'; content: string }>
}

export interface EndWidgetSessionOptions {
  /** Canonical chat/voice transcript rows to repair into durable session history. */
  clientMessages?: Array<{ role: 'user' | 'assistant'; content: string }>
  /** Exact slide filenames actually shown during this session. */
  slidesViewed?: string[]
  elevenLabsConversationId?: string
  elevenLabsConversationIds?: string[]
  email?: string
  name?: string
  company?: string
}

export interface ActivityStep {
  id: string
  label: string
  status: 'running' | 'completed' | 'fallback'
}

export interface SseDeltaEvent {
  type?: 'message_delta'
  delta: string
}

export interface SseActivityEvent {
  type: 'activity_start' | 'activity_step' | 'activity_complete'
  step?: ActivityStep
  status?: 'running' | 'done' | 'fallback'
}

export interface SseProfileGateEvent {
  type: 'profile_gate'
  reason?: string
  disableInput?: boolean
}

export interface SseClientToolCallEvent {
  type: 'client_tool_call'
  turnId: string
  call: ClientToolCall
}

export interface SseClientToolPauseEvent {
  type: 'client_tool_pause'
  turnId: string
  /** Opaque, signed continuation token. It must be returned unchanged. */
  capability: string
  /** Optional server-provided capability expiry hint. */
  expiresAt?: string | number
}

export interface SseErrorEvent {
  type?: 'error'
  error: string
  code?: string
}

export type WidgetSseEvent =
  | SseDeltaEvent
  | SseActivityEvent
  | SseProfileGateEvent
  | SseClientToolCallEvent
  | SseClientToolPauseEvent
  | SseErrorEvent
  | { type: string; [key: string]: unknown }

export interface ChatRequestContext {
  knowledgeKit?: string
  visitorKnowledgeKit?: unknown
  slides?: unknown[]
  slideMetadata?: Record<string, SlideMetadata>
  recommendedSlides?: unknown[]
  recommendedVideos?: unknown[]
  activeVideo?: unknown
  visitorContext?: string
  outreachContext?: string
  discoveryRubric?: unknown
  [key: string]: unknown
}

export interface SendMessageOptions {
  history?: ChatHistoryMessage[]
  context?: ChatRequestContext
  signal?: AbortSignal
}

export interface InitializeOptions {
  session?: WidgetSessionInput
  loadMedia?: boolean
}

export interface ConvincedClientEventMap {
  state: ConvincedClientState
  ready: ConvincedClientState
  message: ChatMessage
  message_delta: { messageId: string; delta: string; text: string }
  content: { messageId: string; content: MessageContentPart[] }
  activity: SseActivityEvent | SseProfileGateEvent
  client_tool_call: SseClientToolCallEvent
  client_tool_pause: SseClientToolPauseEvent
  client_tool_result: ClientToolResult
  identity: { input: IdentityInput; response: IdentityResponse }
  demo_request: WidgetDemoRequestLifecycleEvent
  raw_event: WidgetSseEvent
  error: Error
}

export type ConvincedClientEventName = keyof ConvincedClientEventMap
export type ConvincedClientEventListener<K extends ConvincedClientEventName> = (
  payload: ConvincedClientEventMap[K],
) => void

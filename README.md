# @convinced/widget-sdk

Build an iframe-free, voice-first Convinced experience in any browser application. Use ElevenLabs voice with chat continuity, the headless client with your own UI, the optional Shadow DOM chat widget, registered host-page tools, or a caller-managed MCP client.

The SDK is a thin browser adapter over the Convinced widget API. The Convinced runtime remains the single owner of sales behavior; your application owns presentation, explicit browser capabilities, consent, and MCP connectivity.

## Build it with a coding agent

Copy [`AGENT_BUILD_PROMPT.txt`](https://raw.githubusercontent.com/Get-Convinced/convinced-widget-sdk/main/AGENT_BUILD_PROMPT.txt) into your coding agent while it has access to your web application. The prompt covers a voice-first ElevenLabs integration, custom UI, campaigns, progressive user-confirmed identity, session history, PostHog, SPA/DOM tools, MCP, slides and video, consent, security, and real-browser acceptance.

Read the [Build with a coding agent guide](https://docs.getconvinced.ai/guides/widget-sdk/build-with-an-agent) for the short setup flow. The prompt contains placeholders only; do not add credentials or personal data to it.

## Install

```bash
npm install @convinced/widget-sdk
```

```bash
bun add @convinced/widget-sdk
```

```bash
pnpm add @convinced/widget-sdk
```

The package publishes ESM, TypeScript declarations, and a browser IIFE at `dist/convinced-widget.global.js` (`window.ConvincedWidgetSDK`). It does not require React.

## Mount the default widget

```ts
import {
  ClientToolRegistry,
  ConvincedClient,
  mountConvincedWidget,
} from '@convinced/widget-sdk'

const client = new ConvincedClient({
  orgSlug: 'acme',
  tools: new ClientToolRegistry(),
})

const widget = mountConvincedWidget({
  client,
  placement: 'floating',
  openByDefault: false,
  title: 'Talk to a product specialist',
  theme: {
    primary: '#0f766e',
    onPrimary: '#fffaf2',
    accent: '#fffaf2',
    background: '#f3eee4',
    surface: '#fffaf2',
    text: '#17231e',
    radius: '14px',
    fontFamily: '"Avenir Next", "Segoe UI", sans-serif',
  },
})

// widget.open(), widget.close(), widget.toggle(), widget.destroy()
```

The widget renders inside an open Shadow DOM root, so host styles do not leak into it. Use `placement: 'inline'` with a target to place it in a page layout:

```ts
mountConvincedWidget({
  client,
  placement: 'inline',
  target: '#sales-assistant',
})
```

`autoInitialize` defaults to `true`. Initialization loads configuration, creates a session, and loads slide metadata when slides are enabled.

## Build a fully custom UI

Do not call `mountConvincedWidget` when you want a headless integration. Subscribe to typed events and render state in any framework:

```ts
import { ConvincedClient } from '@convinced/widget-sdk'

const client = new ConvincedClient({ orgSlug: 'acme' })

const unsubscribe = client.on('state', (state) => {
  renderMessages(state.messages)
  setBusy(state.status === 'streaming' || state.status === 'paused')
})

client.on('message_delta', ({ text }) => renderStreamingText(text))
client.on('content', ({ content }) => renderSlidesAndVideos(content))
client.on('activity', (event) => renderActivity(event))
client.on('error', (error) => showError(error.message))

await client.initialize()
await client.sendMessage('How would this work for our warehouse?')

unsubscribe()
// Or: client.off('state', listener)
```

Useful methods are:

- `initialize`, `getConfig`, `createSession`, `renewSession`, `getSlides`, and `getSlideMetadata`
- `sendMessage`, `cancelActiveTurn`, and `captureIdentity`
- `identify`, `track`, `updatePage`, `markVoiceUpgrade`, and `endSession`
- `registerTool`, `on`, `once`, `off`, and `destroy`

## Use ElevenLabs as the primary path

Create the Convinced session first, then obtain a voice descriptor from your server. A public ElevenLabs agent can use `agentId`; a private agent must use a short-lived `signedUrl` (WebSocket) or `conversationToken` (WebRTC). Never return an ElevenLabs API key to browser code.

```ts
import {
  ClientToolRegistry,
  ConvincedClient,
  ConvincedVoiceController,
  mountConvincedWidget,
  registerDomTools,
} from '@convinced/widget-sdk'

const tools = new ClientToolRegistry()
registerDomTools(tools, {
  capabilities: { pageContext: true, navigate: true, scroll: true, highlight: true },
  navigate: (url) => router.navigate(url),
  authorize: ({ action }) => action === 'pageContext' || confirm(`Allow ${action}?`),
})

const client = new ConvincedClient({ orgSlug: 'acme', tools })
await client.initialize()

const voice = new ConvincedVoiceController({
  // Called immediately before every start/reconnect. Return a complete signed
  // descriptor; never return an ElevenLabs API key. This prevents a token from
  // expiring while the widget is idle or collecting identity.
  descriptorFactory: async () => {
    const descriptor = await fetch('/api/convinced/voice-session').then((response) => response.json())
    return {
      ...descriptor,
      // These names must exactly match client tools configured on the EL agent.
      exactClientTools: {
        host_navigate: 'host_navigate',
        host_scroll_to: 'host_scroll_to',
        host_highlight: 'host_highlight',
        host_get_page_context: 'host_get_page_context',
      },
      // Enabled by default. Configure one EL client tool named host_extension_call
      // to dispatch only to tools present in this bounded registry.
      genericClientTool: { name: 'host_extension_call' },
    }
  },
  tools,
  orgSlug: client.orgSlug,
  sessionId: () => client.state.session?.sessionId ?? null,
  authorizeToolCall: ({ tool }) =>
    tool.effect === 'read' || confirm(`Allow ${tool.description}?`),
  onConversationId: (id) => client.linkElevenLabsConversation(id),
})

const widget = mountConvincedWidget({
  client,
  voice,
  preset: 'managed-v2', // the default; use minimal for the compact chat treatment
})

// In always_voice/voice_only, the managed renderer starts on the first PTT
// pointer/key hold, single-flights connection, and keeps the mic muted on
// release, capture loss, blur, or tab hiding. There is no open-mic pre-start.
// Identity remains conversational:
// two free visitor turns, a soft managed form at turn 3, and a hard gate at
// turn 6. The EL agent can fill/confirm the form with the canonical tools.

// Optional push-to-talk controls use ElevenLabs setMicMuted underneath.
pushToTalkButton.onpointerdown = () => voice.startPushToTalk()
pushToTalkButton.onpointerup = () => voice.stopPushToTalk()

// Keep a live call aware of SPA route changes.
router.onChange(async ({ url, title }) => {
  await client.updatePage({ url, title })
  voice.sendContextualUpdate(`The visitor moved to ${title}: ${url}`, 'current-page')
})

await widget.endVoice()
widget.destroy() // synchronous unmount; managed session finalization continues best-effort
```

`managed-v2` follows the session deployment contract: voice is primary for `always_voice` and `voice_only`, chat warms up `smart_gate`, `allowModeToggle` controls the voice/chat switch, campaign pills render before generic suggested questions, and personalized/return-visitor first messages are honored. Voice-led modes start from the first held PTT gesture, then move through free/soft/hard in-conversation gates. Managed identity uses the hosted business-email policy and the spoken fields `name`, `email`, `phone`, and `company`. The renderer supplies bounded exact callbacks for `show_slide`, `show_youtube_embed`, `set_visitor_field`, `request_email_capture`, `show_book_demo_cta`, and `confirm_visitor_form`; descriptor-owned mappings win when a caller supplies a custom implementation. `set_visitor_field` only fills the visible draft. `confirm_visitor_form` is a `per_call` tool: it cannot write identity unless `ConvincedVoiceController.authorizeToolCall` approves that exact invocation. A visitor submitting the visible form remains the default confirmation path. It also applies the hosted appearance contract: `agentAvatarUrl`, `agentTitle`, `showPoweredBy`, `expandEnabled`, and `expandGlowColor` all change rendered controls. `minimal` keeps the compact renderer and does not impose managed identity or presentation behavior.

Return-visitor recognition observes `returnVisitorEnabled` and the bounded `returnVisitorDays` window using server session data. Customer-origin browser storage contains only an opaque, org-scoped SDK visitor key with a bounded lifetime; it never stores the visitor name, email, phone, company, or conversation topic. SDK initialization deletes the older `convinced-visitor-<orgSlug>` PII record, and `forgetBrowserVisitorKey(orgSlug)` clears both current and legacy SDK storage for that organization.

At each managed voice start, the SDK layers the latest Convinced session into
ElevenLabs: server-provided knowledge data, campaign context, ranked slides/videos, current
page observation, chat/voice history, identity state, and the personalized first
message override (including the resolved configured or return-visitor greeting). Page URLs omit query/fragment data, page/transcript excerpts
are explicitly marked untrusted, and the merged variables/overrides are capped
at a 32 KiB initialization budget. A high-priority `CONTEXT_SECURITY_RULES`
variable marks every context/catalog/history field as data only, while slide and
video catalogs remain valid JSON inside explicit untrusted begin/end envelopes.
Chat campaign authority remains server-side; the browser SDK does not promote
client-derived personalization into trusted `outreachContext`.

Chat `[VIDEO:...]` directives are inert unless their URL exactly matches a
video recommended in the initialized Convinced session. Standalone callers of
`parseAssistantContent()` must pass the same exact URLs through its `videos`
option; an unknown model-provided URL never creates an iframe, media request,
or external link.

After confirmed identity, managed voice polls the session-scoped visitor-intel
endpoint for a bounded window and injects ready company context into the same
ElevenLabs conversation as explicitly untrusted reference data. If no safe
`meetingCtaUrl` is configured, the persistent Book demo action and
`show_book_demo_cta` open the hosted-compatible in-widget demo-request form.

A static public agent remains supported with `descriptor: { agentId: '...' }`.
For private agents, prefer factory-only construction as shown above. Every
factory result is revalidated and a cancelled pending start is silenced and
closed before `end()` resolves.

`exactClientTools` maps the exact tool name configured in ElevenLabs to a registered SDK tool. The optional `host_extension_call` gateway accepts the canonical ElevenLabs envelope `{ name, arguments_json }`, where `arguments_json` encodes one JSON object and `name` must be a registered `host_*` or `client_*` tool. Custom callbacks may also pass `{ name, arguments }`. The gateway still enforces the registry schema, argument/result bounds, timeout, effect metadata, and caller consent; it is not arbitrary JavaScript execution. Exact bindings plus this gateway are capped at 16 total voice client tools.

Every voice tool outcome—including MCP failures—is returned inside
`{ trust: "untrusted_tool_observation", source, observation }`; tool text is
data and cannot grant authority. Switching voice→chat includes chronological,
deduplicated EL turns in the next chat request, and managed session end persists
the combined history. Closing a floating managed widget finalizes once; reopening
creates a fresh session with the original campaign/personalized-link attribution.

The hosted widget's optional server-synthesized pre-session greeting audio is
not played automatically by the SDK. The personalized greeting
is rendered and used as the ElevenLabs first-message override. Integrations that
need the separate prelude audio must play their server-created asset before PTT;
do not claim pixel/transport parity for that optional prelude yet.

For tests, inject `conversationFactory` into `ConvincedVoiceController`; this lets a fake transport drive connect/message/tool/disconnect callbacks without a microphone or a live ElevenLabs call.

## Campaign and personalized-link attribution

`initialize()` uses the same attribution order as the managed loader:

1. Explicit `c` passed to `browserSessionInput` (the SDK equivalent of `data-c`)
2. `?c=`
3. `/for/<campaign-token>/`
4. `?utm_campaign=`

An explicit `pid` wins, followed by `?pid=` and then `?cid=`. Campaign tokens are normalized exactly like the loader. The initialized session's governed `knowledgeKit`, recommended slides/videos, loaded slide list, and slide metadata are automatically included in chat context; protocol-owned fields such as `sessionId`, message, history, and signed tool continuation fields remain SDK-owned.

Use the pure `resolveWidgetSessionAttribution(url, overrides)` helper for router/server integration, or `browserSessionInput({ url, c, pid })` to build the complete session payload explicitly.

When session creation returns the opaque `sessionCapability`, the client sends
it only in the `x-widget-session-capability` header on chat (initial and resumed),
identity, context, and end-session writes. It is never placed in a URL or exposed
as an integration credential. Concurrent initialization and end calls are
single-flighted/idempotent per session.

## Add browser tools

Client tools let the server request bounded actions in the page hosting the widget. Every definition is sent with a canonical manifest, every call is matched to that manifest, and every result is returned through the signed continuation loop.

```ts
import {
  ClientToolRegistry,
  ConvincedClient,
  registerDomTools,
} from '@convinced/widget-sdk'

const tools = new ClientToolRegistry()

const removeDomTools = registerDomTools(tools, {
  capabilities: {
    pageContext: true,
    navigate: true,
    scroll: true,
    highlight: true,
  },
  allowedNavigationOrigins: ['https://checkout.acme.com'],
  // Required for host_navigate. This must keep the document alive so the SDK
  // can return the signed continuation after your router changes the route.
  navigate: (url, { replace }) => replace
    ? appRouter.replace(url)
    : appRouter.navigate(url),
  authorize: ({ action, target }) => {
    if (action === 'pageContext') return true
    return window.confirm(`Allow the assistant to ${action}${target ? ` ${target}` : ''}?`)
  },
})

const client = new ConvincedClient({
  orgSlug: 'acme',
  tools,
  authorizeToolCall: ({ tool }) => {
    // A separate protocol-level gate. Session consent is scoped to this
    // registered tool object and is cleared when the SDK creates a new session.
    if (tool.effect === 'read') return true
    return window.confirm(`Allow ${tool.description}?`)
  },
})

// removeDomTools() unregisters this group later.
```

All DOM capabilities default to off. The helper can expose:

| Tool | Effect | Default consent | Boundary |
| --- | --- | --- | --- |
| `host_get_page_context` | read | session | Untrusted observation envelope; redacted URL values, visible text, unique round-trip selectors; excludes form/editable/executable/hidden nodes |
| `host_navigate` | navigate | per call | Explicit non-unloading SPA callback with optional `replace`; current origin plus exact origins you allowlist; HTTP(S) only |
| `host_scroll_to` | mutate | per call | One safe selector |
| `host_highlight` | mutate | per call | One safe selector; temporary style restored after the timer |

Navigation, scrolling, and highlighting deny execution unless `authorize` is `true` or a callback approves the exact action. Broad, executable, or invalid selectors are rejected. In v0.1, `host_navigate` also requires an explicit SPA-router callback. A full-page `location.assign` navigation is deliberately not provided because unloading the document would interrupt the signed continuation.

### Register a custom tool

```ts
import { HOST_TOOL_PROTOCOL_VERSION } from '@convinced/widget-sdk'

client.registerTool({
  version: HOST_TOOL_PROTOCOL_VERSION,
  name: 'host_read_cart',
  description: 'Read product names and quantities from the current cart.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  locality: 'host',
  effect: 'read',
  consent: 'session',
  timeoutMs: 2_000,
  handler: async (_arguments, { signal }) => {
    const response = await fetch('/api/cart', { signal })
    return response.json()
  },
})
```

Names must start with `host_` or `client_`. A client can advertise at most 16 tools, execute at most 16 calls in one round, and execute at most 64 total calls in one continuation chain. Each input schema/constraints object is capped at 12 KB and depth 8, and the full manifest is capped at 48 KB. Tool timeouts may not exceed 30 seconds, serialized results are capped, duplicate call IDs are rejected, and both the server and SDK limit a chat turn to four continuation rounds.

The enforced schema subset includes primitive/object/array types, properties and required fields, additional properties, enums, const values, bounded tuple or uniform items, length/count/numeric bounds, and `anyOf`/`oneOf`/`allOf`. Unsupported assertions such as `pattern`, `format`, `$ref`, and custom keywords are rejected instead of being silently ignored. Tool results use the same 32 KB and depth-8 boundary.

Manifest prose is not trusted prompt content. The production runtime digest-binds the complete manifest, strips tool descriptions, constraints, and schema annotations from trusted tool/system instructions, and supplies the short description only inside a clearly marked untrusted data block. Give each capability a clear namespaced identifier and a structural schema; do not put behavioral instructions in its description.

The SDK automatically manages the opaque `clientToolCapability` returned by the server. Do not persist, inspect, or construct that value yourself.

## Adapt a caller-managed MCP client

`createMcpTools` accepts an already configured MCP Client-like object. It does not create a transport, store credentials, or connect to an MCP server for you.

```ts
import { createMcpTools } from '@convinced/widget-sdk'

// Created and authenticated by your application with the official MCP SDK.
const officialMcpClient = getAuthenticatedMcpClient()

const mcpTools = await createMcpTools(officialMcpClient, {
  // Required: MCP discovery is deny-by-default.
  allow: ['inventory_lookup', 'create_quote'],
  policy: (tool) => tool.name === 'inventory_lookup'
    ? { effect: 'read', consent: 'session' }
    : { effect: 'mutate', consent: 'per_call' },
})

client.tools.registerMany(mcpTools)
```

If an MCP action has no explicit policy, it is conservatively advertised as `mutate` with `per_call` consent. Keep MCP credentials and network access on infrastructure you control; never put privileged secrets in a public browser bundle.

## Customize identity collection

The server can emit a soft or hard `profile_gate`. The default widget shows a safe email-first form. A hard gate locks the composer until `captureIdentity` succeeds; a soft gate leaves chat available.

Customize when and how the form appears with `identityPolicy`:

```ts
mountConvincedWidget({
  client,
  identityPolicy: ({ assistantMessages, state }) => {
    if (state.identity || assistantMessages < 2) return false
    return {
      title: 'Get your tailored rollout plan',
      description: 'Where should we send it?',
      submitLabel: 'Send my plan',
      fields: ['email', 'name', 'company', 'phone'],
    }
  },
})
```

The policy may be asynchronous. Email is always included and required. Headless integrations can listen for `profile_gate` on the `activity` event and call `client.captureIdentity(...)` from their own form.

## Slides and videos

Assistant text can contain media directives:

```text
[SLIDE:warehouse-automation.svg]
[VIDEO:https://www.youtube.com/watch?v=M7lc1UVf-VE|Warehouse tour]
```

The client converts these into typed `message.content` parts. Video media is emitted only when the URL exactly matches the initialized Convinced recommendation catalog; every other model-provided URL is inert. For approved URLs, the default widget uses privacy-enhanced YouTube embeds, supports Vimeo, renders direct HTTP(S) MP4/WebM/Ogg sources, and can fall back to a safe external link.

For a custom renderer, use `parseAssistantContent`, `stripAssistantDirectives`, and `toSafeVideoEmbedUrl`.

## Browser script

Self-host `dist/convinced-widget.global.js`, or load the exact published version with Subresource Integrity. The API is exposed on `window.ConvincedWidgetSDK`:

```html
<script
  src="https://cdn.jsdelivr.net/npm/@convinced/widget-sdk@0.1.0/dist/convinced-widget.global.js"
  integrity="sha384-XjRavyNaP8UvXWpOnEledOkpzyp7mcrvuR9dOgeDYP0D/yEYzkAVR8VkFLngErxQ"
  crossorigin="anonymous"
></script>
<script>
  const client = new ConvincedWidgetSDK.ConvincedClient({ orgSlug: 'acme' })
  ConvincedWidgetSDK.mountConvincedWidget({ client })
</script>
```

## Run the sample storefront

The included vanilla app uses the browser IIFE and a local mock API. It demonstrates a custom theme and identity policy, an opaque pause/resume continuation matching the production contract, scroll/highlight actions on the storefront DOM, and slide/video rendering. The production Convinced runtime signs the continuation capability; the local mock uses a static opaque placeholder and auto-approves its two page mutations for demonstration only.

From the SDK repository root (or an unpacked package directory):

```bash
bun install
bun run build
bun run example
```

Open [http://localhost:4173](http://localhost:4173), open the assistant, and send the suggested question. The mock runtime scrolls to and highlights the featured robot before returning media. Submit the identity form to exercise `captureIdentity`.

## Develop and publish

```bash
bun run typecheck
bun test
bun run build
npm pack --dry-run
```

`dist/index.js` is the ESM entry and keeps `@elevenlabs/client` as a lazy runtime dependency; `dist/index.d.ts` contains declarations. `dist/convinced-widget.global.js` is the self-contained standalone browser build. The package is configured for public npm publishing with provenance.

## Security model

- Treat advertised tools as capabilities, not prompt instructions. Register only the minimum set needed for the current page.
- Use both the client `authorizeToolCall` gate and the tool-specific `authorize` gate for browser mutations.
- Keep privileged MCP clients and secrets outside the browser whenever possible.
- Tool calls are accepted only inside a server-paused turn with a matching turn ID and opaque, short-lived signed continuation capability. Production capabilities are bound to the exact base request and accepted once.
- The SDK rejects mismatched manifests, duplicate or excess call IDs, oversized results, expired capabilities/local timeouts, and continuation chains beyond four rounds. If a resume has already been claimed and the network fails, start a new chat turn rather than replaying it.
- The wiki or page DOM is context, not automatically trusted truth. The Convinced runtime still owns retrieval, proof selection, and user-facing sales behavior.

## License

MIT

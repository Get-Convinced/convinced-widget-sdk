# Convinced Widget SDK 0.1.9

A headless browser SDK for adding one Convinced agent to any website. The host application owns the UI. Convinced owns the signed session, server-agent conversation, knowledge, prompts, and provider credentials.

Version 0.1.9 uses one conversation for text and speech:

- The Convinced server agent produces grounded answers, Markdown, media directives, and tool decisions.
- `gpt-live-1` is an optional full-duplex speech input/output layer.
- Live handles brief conversational replies and delegates organization facts, reasoning, and page actions to the same backend conversation. Typed input while voice is active stays in that conversation and is spoken automatically.
- A deliberate typed request during an active delegated voice task replaces that task before the server agent runs another host tool.
- Ending voice leaves chat active. Chat-only use creates no Live session.
- One `ClientToolRegistry` powers chat, speech, slides, forms, page actions, and WebMCP.

No OpenAI key or provider configuration belongs in browser code. A browser receives only public organization/deployment identifiers and a short-lived signed session capability.

## Fixed in 0.1.9

Live now keeps a caller's question when it speaks a brief acknowledgement before delegating the same turn. It can reclaim that question after the caption has flushed, without leaving a duplicate native exchange in chat history. A stale delegation cannot claim a newer question; if Live delegates with no transcript, it asks the caller to repeat. The SDK and backend still use the same session, tools, and provider configuration.

## Added in 0.1.8

The paired backend selects its server-agent model; the browser does not. `gpt-live-1` remains the optional voice layer. With a compatible backend, a delegated voice request can pass short, verified findings to Live as they arrive, followed by the final briefing after chat completes. Provisional chat text can be reset and replaced during a signed host action. Live caller and assistant captions accumulate independently during overlap, while caller-turn words remain intact across assistant backchannels. Mute intent stops local capture and gates new input events immediately. An acoustic retest is still needed for the reported unexpected caller fragments and muted-session interruption; synthetic tests do not prove those conditions resolved.

The signed `client.describeScreen(imageDataUrl, { signal })` method can describe one visitor-approved JPEG or PNG frame. The host owns permission, capture, and teardown. The SDK still supports host-owned slides, forms, identity, and other registered actions; each website chooses which capabilities to wire. See the [changelog](CHANGELOG.md), [screen observation guide](docs/screen-observation.md), and [speech ownership guide](docs/voice-session-ownership.md).

In browsers, the SDK captures a bounded public snapshot of the current `<main>` when a session starts and for each chat turn. It prioritizes content in the viewport and sends Live updates after page, scroll, or resize changes. The snapshot includes a public heading, semantic cards, links, section references, and compact public text. Forms, editors, dialogs, widget UI, hidden and marked private content are excluded; private or token-bearing URL paths suppress the snapshot, and unsafe links are omitted. Add site-specific UI roots with `pageSnapshot: { excludeSelectors: ['#your-agent-rail'] }`, or disable automatic capture with `pageSnapshot: { enabled: false }`. Page content is untrusted data; it cannot grant tool access or change agent instructions. When the tool registry has room, the SDK offers `host_focus_page_section` for scrolling to and briefly highlighting an exact public section title. Its receipt confirms presentation only after the section is actually visible; otherwise it reports a requested scroll or failed verification. Registered site actions always retain their slots.

## Install

```bash
npm install --save-exact @convinced/widget-sdk@0.1.9
```

## Headless quickstart

```ts
import {
  ClientToolRegistry,
  ConvincedClient,
  registerDomTools,
} from '@convinced/widget-sdk'

const tools = new ClientToolRegistry()
registerDomTools(tools, {
  capabilities: { scroll: true, highlight: true },
  authorize: async ({ action, target }) => {
    return showYourConsentUi({ action, target })
  },
})

const client = new ConvincedClient({
  orgSlug: 'acme',
  agentId: 'deployment_acme_site',
  tools,
  authorizeToolCall: async ({ call, tool }) => {
    if (tool.consent === 'none') return true
    return showYourConsentUi({ action: call.name, target: call.args })
  },
})

await client.initialize()

client.on('message', (message) => renderMessage(message))
client.on('content', ({ content }) => renderRichContent(content))
client.on('client_tool_result', (result) => recordToolOutcome(result))

await client.sendMessage('Show how this works for my team')
```

`agentId` is a public Convinced `AgentDeployment` ID. The backend verifies that it belongs to `orgSlug`; it is not an OpenAI or speech-provider identifier.

The SDK returns normalized messages and structured content. Your renderer decides where chat appears, how Markdown looks, whether a slide opens inline or in a modal, and how navigation works.

## Add full-duplex speech

Create one Live controller and reuse it when the visitor enables or disables voice.

```ts
const live = client.createLiveController()

await live.start({
  context: 'Page: pricing. Selected plan: Growth.',
  startMuted: false,
})

live.setMuted(true)
live.setMuted(false)
live.sendContextualUpdate('The visitor opened the ROI section.', 'roi-section')

// Typed input still goes through the server agent and is spoken while Live is connected.
await client.sendMessage('Compare the two plans')

// Voice off; the backend conversation remains active.
await live.end()
await client.sendMessage('Send me the implementation steps')

// Close the durable Convinced session when the whole experience ends.
await client.endSession({ slidesViewed: ['roi-overview.png'] })
```

The browser sends its SDP offer to the Convinced backend. The backend creates `gpt-live-1` with client delegation. Live can answer short conversational turns directly. The SDK records those completed exchanges in the shared session history, so typed and delegated follow-ups retain their context. When Live delegates, the SDK sends the current utterance through the backend conversation. The server agent produces the canonical rich answer and runs the shared tool registry through the signed chat continuation. A short, verified voice briefing goes to Live for natural speech. A newer delegation cancels the older chat and tool work before starting the correction.

If the backend cannot supply a voice briefing, Live receives one complete sentence from the written answer, or a short invitation to explore the details in chat. Page context can still be up to 8 KiB; the SDK sends it in small ordered updates that fit the Live append limit.

The SDK allows one Live controller per `ConvincedClient`. This prevents duplicate microphones, speech, and paid sessions. Reuse the controller across enable/disable cycles.

## Host tools and slides

Register only actions the current page can execute and verify. A handler must return the actual result after the UI action completes.

```ts
tools.register({
  version: 1,
  name: 'host_show_slide',
  description: 'Show one published slide inline.',
  inputSchema: {
    type: 'object',
    properties: { filename: { type: 'string' } },
    required: ['filename'],
    additionalProperties: false,
  },
  locality: 'host',
  effect: 'navigate',
  consent: 'none',
  timeoutMs: 5_000,
  async handler({ filename }) {
    await showSlideInline(String(filename))
    return { status: 'shown', filename }
  },
})
```

For chat, the backend signs the exact server-agent tool call, pauses the turn, and accepts only the matching result before resuming. For speech, the same registry and authorization policy apply. A model request never bypasses the host handler or its consent policy.

## WebMCP

Publish the page's existing registry when the browser exposes WebMCP:

```ts
const publisher = client.publishToolsToWebMcp()

await publisher?.ready

// On route teardown:
publisher?.dispose()
```

`publishToolsToWebMcp()` makes the client's existing bounded capabilities discoverable without duplicating handlers or authorization. `createWebMcpBridge` is available when the Convinced agent must discover tools that another same-origin component registered. Do not add one SDK method per website action; use the registry and WebMCP manifest.

WebMCP is still browser-dependent. Feature-detect it and keep the direct registry path so chat and speech work when the browser does not expose WebMCP.

## Optional managed widget

`mountConvincedWidget()` is a convenience renderer. It is optional and does not define the headless contract.

```ts
const live = client.createLiveController()
const widget = mountConvincedWidget({ client, voice: live })
```

A custom React, Vue, Svelte, or plain-DOM UI should subscribe to the client events and render the same messages and content itself.

## Persistent prompt and opening-message edits

Management belongs in an authenticated customer admin surface, never in visitor-callable tools.

```ts
import { ConvincedAgentAdmin } from '@convinced/widget-sdk'

const admin = new ConvincedAgentAdmin({
  orgSlug: 'acme',
  agentId: 'deployment_acme_site',
  apiBase: 'https://app.getconvinced.ai',
})

const current = await admin.getPrompt()
const saved = await admin.updatePrompt({
  systemPrompt: 'You are Acme’s concise implementation guide...',
  firstMessage: 'What would you like to improve today?',
  expectedRevision: current.revision,
})
```

The API requires an authenticated organization `ADMIN`, checks deployment ownership, persists both fields in Convinced, and uses revision compare-and-swap to prevent silent overwrites.

`ConvincedAgentAdmin` sends same-origin credentials. Run it on the authenticated Convinced admin origin, or point `apiBase` at an authenticated same-origin management proxy on the customer's admin site. A public customer page cannot call the management endpoint directly.

## Security rules

- Keep OpenAI keys, Convinced server secrets, and management credentials on the backend.
- Browser code may contain `orgSlug`, a Convinced `agentId`, and an embed/widget token where your deployment requires one.
- The backend binds the signed session capability to the organization and session. Live creation and session end require it.
- Tool names, schemas, payloads, results, timeouts, and counts are bounded.
- Treat tool output as untrusted observation data.
- Require explicit host approval for `session` and `per_call` actions.
- Use HTTPS in production and allow only the Convinced API plus approved media/analytics origins in CSP.

## Included guides

- [Speech and session ownership](docs/voice-session-ownership.md)
- [WebMCP handoff](docs/webmcp-handoff.md)
- [Prompt management](docs/agent-prompt-management.md)
- [`AGENT_BUILD_PROMPT.txt`](AGENT_BUILD_PROMPT.txt), a compact implementation brief for coding agents

OpenAI protocol references:

- [Live API](https://developers.openai.com/api/docs/guides/live)
- [Live delegation](https://developers.openai.com/api/docs/guides/live-delegation)
- [Live prompting](https://developers.openai.com/api/docs/guides/live-prompting)
- [Live conversations](https://developers.openai.com/api/docs/guides/live-conversations)

## Verification

```bash
bun run check
npm pack --dry-run
```

`bun run check` type-checks the SDK, runs the SDK tests, builds ESM/types/standalone browser output, installs the packed tarball in a clean consumer, compiles it with Bundler and NodeNext resolution, checks Node and Bun imports, and audits production dependencies.

# Convinced Widget SDK 0.1.4

A headless browser SDK for adding one Convinced agent to any website. The host application owns the UI. Convinced owns the signed session, Luna conversation, knowledge, prompts, and OpenAI credentials.

Version 0.1.4 uses one conversation for text and speech:

- `gpt-6-luna` produces the canonical answer, Markdown, media directives, and tool decisions.
- `gpt-live-1` is an optional full-duplex speech input/output layer.
- Spoken input is delegated to the same Luna chat. Typed input while voice is active stays in that chat and is spoken automatically.
- Ending voice leaves chat active. Chat-only use creates no Live session.
- One `ClientToolRegistry` powers chat, speech, slides, forms, page actions, and WebMCP.

No OpenAI key or provider configuration belongs in browser code. A browser receives only public organization/deployment identifiers and a short-lived signed session capability.

## Install

```bash
npm install --save-exact @convinced/widget-sdk@0.1.4
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

// Typed input still goes through Luna and is spoken while Live is connected.
await client.sendMessage('Compare the two plans')

// Voice off; the Luna chat remains active.
await live.end()
await client.sendMessage('Send me the implementation steps')

// Close the durable Convinced session when the whole experience ends.
await client.endSession({ slidesViewed: ['roi-overview.png'] })
```

The browser sends its SDP offer to the Convinced backend. The backend creates `gpt-live-1` with client delegation. When Live recognizes an utterance, the SDK sends it through `client.sendMessage()`. Luna produces the canonical rich answer and runs the shared tool registry through the signed chat continuation; Live receives that verified answer as commentary and explains it naturally in speech.

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

For chat, the backend signs the exact Luna tool call, pauses the turn, and accepts only the matching result before resuming. For speech, the same registry and authorization policy apply. A model request never bypasses the host handler or its consent policy.

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

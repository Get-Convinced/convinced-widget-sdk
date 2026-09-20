# Headless voice belongs to the Convinced session

SDK version: `0.1.1-webmcp.3`. Use it with the Convinced hosted transcript-reconciliation backend, deployed on 21 September 2026. Self-hosted installations need the companion backend change.

Create voice through the client which owns the Convinced session:

```ts
import { ConvincedClient } from '@convinced/widget-sdk'

const client = new ConvincedClient({ orgSlug: 'your-org' })
await client.initialize({ loadMedia: false })
const voice = client.createVoiceController()
client.on('message', message => renderMessage(message))
await voice.start()

// On the visitor's explicit session close:
await client.endSession()
```

`renderMessage` is your UI callback. The client receives normalized `user` and `assistant` messages from both text and voice. `voice.sendUserMessage()` also records typed turns, since the provider does not echo those through its transcript callback. It records provider conversation IDs internally, carries the Convinced session ID into the voice transport, and retains turns across reconnects. `endSession()` stops its voice controllers, includes any final captured turns, and submits the transcript without provider-specific arguments from the application.

`voice.end()` stops voice while leaving the Convinced session available for text or reconnection. After a successful `client.endSession()`, call `client.renewSession()` before starting a new conversation. Wait for any active text request before ending the session. A failed HTTP save rejects; retry `client.endSession()` before discarding the client. `destroy()` releases resources; it is not a replacement for awaiting session persistence. Browser termination can still interrupt an HTTP save.

For WebMCP, supply the bridge registry and its two fixed bindings. The following fragment assumes your page has a supported `modelContext` and an explicit `permittedPageTools` set:

```ts
import { ClientToolRegistry, createWebMcpBridge, WEBMCP_VOICE_BINDINGS } from '@convinced/widget-sdk'

const bridge = createWebMcpBridge({
  modelContext, // the available same-origin WebMCP context
  origin: window.location.origin,
  authorize: tool => permittedPageTools.has(tool.name),
})
const voice = client.createVoiceController({
  tools: new ClientToolRegistry(bridge.tools),
  exactClientTools: WEBMCP_VOICE_BINDINGS,
  genericClientTool: false,
})
await voice.start()
// Before removing this page:
await client.endSession()
bridge.dispose()
```

Convinced must configure the session's hosted agent for those bindings. The SDK version alone does not configure its tools or change which agent receives traffic. A server-supplied `descriptorFactory` remains available for signed/private descriptors and refreshes on every start. The factory receives the Convinced session ID; callers never need a provider API key.

The standalone `new ConvincedVoiceController(...)` remains a low-level adapter for existing integrations. It is not automatically attached to a `ConvincedClient`. Migrate headless integrations to `client.createVoiceController(...)` and remove manual provider-ID callbacks and transcript buffering. UI-only `onMessage` callbacks can remain. Subscribe to `client.on('message', ...)` to render the combined text/voice stream. Your renderer still records which slides it actually shows and can pass `slidesViewed` to `endSession()`; the session cannot infer that presentation state.

Backend companion change: session finalization merges snapshots with stored text; retries do not skip the whole batch. Voice turns carry an internal source identifier, so provider imports can reconcile the same conversation while preserving repeated words and reconnects. Summaries and products use the merged stored history. Each persisted turn is still limited to 5,000 characters; snapshots exceeding 2,000 turns fail explicitly. This is not an unlimited archive or a guarantee against browser termination, provider omissions, or provider delivery failures.

Summary generation is separate from transcript persistence. Model failures or input above the 120,000-character summary budget leave the transcript stored and its summary pending. The budget counts the formatted transcript; it does not truncate stored turns. No background summary retry worker is included. Convinced can retry finalization or provider sync after a transient failure; a conversation above the budget needs a separate summarization strategy. A successful `endSession()` is cached by the SDK and does not promise a summary field or trigger further server work on repeat calls.

Convinced must configure the chosen agent for the page's exact bindings. The SDK cannot change those settings. Production rejects unsigned provider webhooks; operators must provision signing and delivery separately. Immediate browser capture does not rely on a webhook arriving before finalization. This release does not add the hosted private-voice credential endpoint or change provider retry settings.

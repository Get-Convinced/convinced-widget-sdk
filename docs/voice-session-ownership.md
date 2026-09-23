# Speech and session ownership

SDK 0.1.7 keeps one Convinced session across text, speech, media, knowledge, and host tools. `gpt-live-1` supplies optional full-duplex conversation; Luna handles grounded answers and tool decisions.

```ts
const client = new ConvincedClient({ orgSlug, agentId, tools })
await client.initialize()
const live = client.createLiveController()
await live.start({ startMuted: false })
```

Live can handle brief conversational turns directly. The SDK records completed Live-native user and assistant exchanges in the same session history and emits a state update without duplicating the Live caption event. Typed and delegated Luna turns inherit that context in order. Luna uses the same prompt, knowledge, and tools as typed chat. Its canonical answer appears through the normal client message/content events. The Live connection receives a short verified briefing as commentary and speaks a natural rendering. A newer delegation aborts the previous chat and remaining host tools; the previous answer is not spoken.

Each Live commentary or thinking append stays within a conservative 450-byte limit. The SDK strips media directives from spoken text and splits page context into ordered updates without dropping the 8 KiB aggregate context. If the backend omits a briefing, the SDK uses a complete sentence from the visible answer instead of clipping its middle.

Host tool handlers receive an `AbortSignal`. A spoken correction aborts the older turn, stops later tools in that turn, and suppresses its response. A handler that has already started must honor its signal to stop its own side effect; the SDK cannot undo a completed page action.

Typed messages always use `client.sendMessage()`. If Live is connected, the completed Luna answer is also sent to Live for speech. Ending Live stops microphone/audio transport and leaves the chat session usable:

```ts
await live.end()
await client.sendMessage('Continue in text')
```

Create one controller per client and reuse it. The SDK rejects a second controller so remounts cannot accidentally create duplicate microphones, billing, or speech.

Call `client.endSession()` only when the entire experience ends. The backend already recorded the opaque Live session ID when it created the transport; the browser does not submit provider IDs. `endSession()` can include the exact slide filenames your renderer showed because presentation state belongs to the host.

The browser never receives an OpenAI key. Session creation returns an opaque signed capability. The SDK sends it on Live creation, context writes, and session end; the backend checks organization/session binding and expiry.

# Speech and session ownership

SDK 0.1.3 keeps one Convinced session and one Luna conversation across text, speech, media, knowledge, and host tools. `gpt-live-1` supplies optional full-duplex audio; it does not own a second assistant brain.

```ts
const client = new ConvincedClient({ orgSlug, agentId, tools })
await client.initialize()
const live = client.createLiveController()
await live.start({ startMuted: false })
```

When a visitor speaks, Live emits a client delegation. The SDK accumulates the input transcript, including segments separated by a pause, and sends one turn through `client.sendMessage()`. Luna uses the same history, prompt, knowledge, and tools as typed chat. The canonical Luna answer appears through the normal client message/content events. The Live connection receives a bounded, faithful copy as commentary and speaks a natural rendering.

Typed messages always use `client.sendMessage()`. If Live is connected, the completed Luna answer is also sent to Live for speech. Ending Live stops microphone/audio transport and leaves the chat session usable:

```ts
await live.end()
await client.sendMessage('Continue in text')
```

Create one controller per client and reuse it. The SDK rejects a second controller so remounts cannot accidentally create duplicate microphones, billing, or speech.

Call `client.endSession()` only when the entire experience ends. The backend already recorded the opaque Live session ID when it created the transport; the browser does not submit provider IDs. `endSession()` can include the exact slide filenames your renderer showed because presentation state belongs to the host.

The browser never receives an OpenAI key. Session creation returns an opaque signed capability. The SDK sends it on Live creation, context writes, and session end; the backend checks organization/session binding and expiry.

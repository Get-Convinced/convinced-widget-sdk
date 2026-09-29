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

Submitting a typed message while a delegated voice task is running cancels that task before the typed turn enters the same Luna queue. Speech backchannels remain within Live and do not call `sendMessage()`.

```ts
await live.end()
await client.sendMessage('Continue in text')
```

Create one controller per client and reuse it. The SDK rejects a second controller so remounts cannot accidentally create duplicate microphones, billing, or speech.

Call `client.endSession()` only when the entire experience ends. The backend already recorded the opaque Live session ID when it created the transport; the browser does not submit provider IDs. `endSession()` can include the exact slide filenames your renderer showed because presentation state belongs to the host.

The browser never receives an OpenAI key. Session creation returns an opaque signed capability. The SDK sends it on Live creation, context writes, and session end; the backend checks organization/session binding and expiry.

## Unreleased local streaming and transcript behavior

For a delegated turn, the backend can emit a compact verified `voice_context` finding before its final answer. The SDK forwards that finding as Live commentary immediately; `voice_thinking` is quiet progress. The final `voice_briefing` is sent after the chat stream completes, even if its text matches an earlier finding. Arbitrary partial chat text is not spoken as a finding. The SDK opts in with `streamProtocol: 1` on chat requests; only opted-in clients can receive provisional deltas and a `text_reset` event before corrected answer chunks. Published `0.1.7` clients omit this field and need the original final-only delta behavior. Cancellation and generation checks prevent stale delegated updates from being forwarded after a correction or ended voice session. A Live append acknowledgement confirms context injection, not audio playback.

Live input and output transcript deltas are appended independently during full-duplex overlap. The SDK preserves repeated words from distinct events and ignores an exact replay of an event ID. Caller-turn words are tracked separately from caption flushes, so an assistant backchannel cannot consume the beginning of a delegated request. It groups captions for display without treating them as proof that the visitor spoke; Live has no transcript-done event. Native spoken exchanges are still copied into the shared conversation before a later delegated or typed turn. Mute intent disables the local microphone track and gates new input transcripts and delegations immediately. Only the newest matching provider acknowledgement may confirm that intent; a stale acknowledgement cannot reverse it.

These changes are in the local worktree and have not been published as a new SDK version. The mute acknowledgement has no transcript timeline offset, so an input delta delivered after an acknowledgement cannot safely be classified as new or delayed from client metadata alone. The Transformation pilot has reported unexpected transcript and model interruption even while muted; the new gate needs an acoustic retest before claiming that report is resolved.

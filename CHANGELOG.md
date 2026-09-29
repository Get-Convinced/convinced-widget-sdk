# Changelog

## Unreleased local worktree

- Forward bounded, verified `voice_context` findings and quiet `voice_thinking` progress from a delegated Luna turn to Live before the final answer. Keep arbitrary chat text deltas out of Live commentary; send the final `voice_briefing` after the stream completes. Handle backend `text_reset` when provisional chat text must be replaced.
- Add `ConvincedClient.describeScreen(imageDataUrl, { signal })` for one JPEG or PNG frame under 1 MiB through the signed session. Return a textual observation without retaining image bytes in client state. The host obtains and controls browser tab-sharing permission.
- Keep Live caller and assistant transcript buffers independent during overlap. Track caller-turn words separately from caption flushes so assistant backchannels do not truncate delegated requests. Ignore exact replayed transcript event IDs while preserving repeated words from distinct events and the native conversation context used by later turns.
- Apply mute intent to local capture and transcript/delegation gating immediately. Match provider acknowledgements to the newest command's `client_event_id`, preventing an older acknowledgement from changing the displayed mute state.

These changes are local and are not part of a published release. The reported unexpected user transcript and model interruption while the Transformation pilot was muted needs an acoustic retest; synthetic ordering tests alone do not prove that real microphone capture is fixed.

## 0.1.7

Published SDK baseline. The API continues to support shared text and Live sessions, host tool and WebMCP registries, slide/content rendering choices, forms, and identity flows. Host applications must wire the actions and UI they intend to offer.

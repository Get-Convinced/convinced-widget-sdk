# Changelog

## 0.1.9

- Keep the latest caller question available when Live acknowledges it and then delegates the same turn, including after caption flush. Reclaiming that question removes its provisional native exchange from shared history, so the delegated question appears once.
- Ignore a delegation whose timeline predates a newer caller, without consuming that caller. If a delegation truly has no transcript after the existing wait, send a brief recoverable Live response asking the caller to repeat.
- Preserve the 0.1.8 chat, tool, page-snapshot, mute, and backend configuration contracts. This patch does not resolve the separately reported unexpected input fragments during digitally silent or muted audio.

## 0.1.8

- Capture bounded, semantic public `<main>` snapshots at session start and on chat turns. Prioritize visible content; update Live context on meaningful page, scroll, and resize changes. Exclude private, hidden, interactive, and widget content, suppress snapshots for unsafe URL paths, and omit unsafe links. A compatible backend can use current-page evidence before looking up deeper knowledge.
- Offer `host_focus_page_section` when the registry has room. Scroll to a named public section and report a verified presentation only once it is actually visible; preserve every registered host tool.
- Forward bounded, verified `voice_context` findings and quiet `voice_thinking` progress from a delegated backend turn to Live before the final answer. Keep arbitrary chat text deltas out of Live commentary; send the final `voice_briefing` after the stream completes. Opt in with `streamProtocol: 1` to provisional public chat deltas and handle backend `text_reset` when they must be replaced.
- Add `ConvincedClient.describeScreen(imageDataUrl, { signal })` for one JPEG or PNG frame under 1 MiB through the signed session. Return a textual observation without retaining image bytes in client state. The host obtains and controls browser tab-sharing permission.
- Keep Live caller and assistant transcript buffers independent during overlap. Track caller-turn words separately from caption flushes so assistant backchannels do not truncate delegated requests. Ignore exact replayed transcript event IDs while preserving repeated words from distinct events and the native conversation context used by later turns.
- Apply mute intent to local capture and transcript/delegation gating immediately. Match provider acknowledgements to the newest command's `client_event_id`, preventing an older acknowledgement from changing the displayed mute state.

The reported unexpected caller transcript and model interruption while the Transformation pilot was muted need an acoustic retest. Synthetic ordering tests do not prove that real microphone capture is fixed.

## 0.1.7

Published SDK baseline. The API continues to support shared text and Live sessions, host tool and WebMCP registries, slide/content rendering choices, forms, and identity flows. Host applications must wire the actions and UI they intend to offer.

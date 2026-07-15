# Managed SDK preset

This example mounts the SDK’s managed voice-first renderer in one call:

- `mountConvincedWidget({ preset: 'managed-v2', client, voice })` owns the rendered experience.
- `ConvincedVoiceController` supplies ElevenLabs voice and the shared host-tool registry.
- `ConvincedClient` owns campaign session, media, identity, chat, and end-session state.

It reproduces the hosted widget’s core behavior contract: voice modes, voice/chat switching, campaign pills and greeting, media, identity policy, push-to-talk, and lifecycle. It is not a claim that every historical hosted launcher is a pixel-identical preset.

```bash
bun run build
bun run examples/managed-parity/server.ts
```

Open the printed campaign URL. Voice is the leading action: hold the PTT control
to connect and speak, then release to mute. The visitor gets two free voice turns;
the managed identity form becomes soft on turn three and hard on turn six, or the
agent can request it with `request_email_capture`. Campaign pills feed the same
renderer, which also renders the local proof slide and video directive. The
browser hook is `window.__managedParityDemo`; it exposes the current bounded
`voiceStartContext`, the gate contract, the managed PTT element, client/voice
state, and trace. Server observations are at `/api/demo-state`.

Remove `?c=lumen-expansion` from the URL to exercise the generic inbound
fallback. The sample returns no target company, campaign opener, knowledge kit,
or recommended campaign media on that path, so it also catches cross-target
context leaks.

For a disposable public ElevenLabs agent, set `ELEVENLABS_AGENT_ID=agent_xxx` on
the server and open the URL with `?voice=real`. The provider key remains
server-side; private production agents should use a freshly issued signed URL or
conversation token through `descriptorFactory`. The automated live script in
the app repository must use a held PTT gesture and three recognized visitor
utterances (or the canonical identity tool); the old pre-start form sequence is
not valid for `always_voice`.

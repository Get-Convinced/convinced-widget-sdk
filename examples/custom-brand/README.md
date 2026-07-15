# Custom-brand example

This example uses the headless `ConvincedClient` and `ConvincedVoiceController` directly. All layout, campaign pills, media presentation, identity timing, and visual behavior belong to the host application.

```bash
bun run build
bun run examples/custom-brand/server.ts
```

Open the printed campaign URL. **Begin voice** exercises the same voice adapter as a real ElevenLabs session through a deterministic conversation factory. The campaign pills exercise chat, slides, and video. **Email this story** demonstrates a custom identity enquiry rather than the SDK’s stock form.

Inspect `window.__customBrandDemo` for test control and `/api/demo-state` for captured session, identity, and context payloads.

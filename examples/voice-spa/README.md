# Voice-first SPA example

This no-framework app proves the SDK can run on top of a real History API SPA. It has three server-addressable routes, stable DOM targets, campaign attribution, a trace inspector, all four bounded host-page tools, and a caller-managed MCP adapter that reaches a local demo transport through `host_extension_call`.

```bash
bun run build
bun run examples/voice-spa/server.ts
```

Open the printed `/home?c=...` URL. The default is a deterministic ElevenLabs-compatible conversation factory: start voice, then use **Ask: pricing** and **Ask: proof**. Both actions travel through `ConvincedVoiceController`, the voice client-tool adapter, the shared registry, and the actual SPA router.

For a public ElevenLabs agent, provide its id on the server and request live mode:

```bash
ELEVENLABS_AGENT_ID=agent_xxx bun run examples/voice-spa/server.ts
```

Then open `/home?voice=real`. No ElevenLabs API key is sent to the browser. A private agent should use a server-issued signed URL or conversation token in a production integration.

The browser test hook is `window.__voiceSpaDemo`; the local API state is available at `/api/demo-state`.

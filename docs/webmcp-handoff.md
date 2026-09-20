# WebMCP SDK experiment — Enovate handoff

Historical page-action trials below were tested on 14 September 2026 with `0.1.1-webmcp.2`. The updated session integration example targets `0.1.1-webmcp.3` and the deployed transcript-reconciliation backend. See [voice session ownership](voice-session-ownership.md) for migration, persistence limits and rollout requirements. On 21 September the `.3` native Chrome fixture passed all five checks, including automatic voice capture/finalization, with simulated provider transport.

## Decision

Use WebMCP as the shared website capability interface. A website registers business actions; the Convinced SDK discovers their schemas and invokes them without customer-specific tool mappings. The prototype works on native Chrome and on Google's independently authored public pizza demo.

This is a viable SDK direction, not a production-readiness claim. A website must adopt WebMCP, the browser must support it or load a compatible implementation, and the agent still needs to select the right action. WebMCP does not make arbitrary uninstrumented websites callable or repair inaccurate page handlers.

## What is implemented

- `getWebMcpModelContext()`: feature detection, preferring `document.modelContext` with legacy navigator fallback.
- `publishRegistryToWebMcp(registry, options)`: migration adapter publishing existing tools with their schemas and the same validation, authorization, handlers, timeout rules, and results. Registration is tied to an AbortSignal and cleaned up on page unmount. Registering more tools after publication requires disposing and republishing this snapshot.
- `createWebMcpBridge(options)`: website-independent discovery and execution. Same-origin tools only. Eight catalog summaries per page; one complete schema on demand. Opaque handles are scoped to this bridge, origin, window, and tool signature; `toolchange` invalidates them. The host authorizes every underlying invocation. No automatic mutation retry or evaluation of arbitrary JavaScript.
- `WEBMCP_VOICE_BINDINGS`: the same two ElevenLabs callbacks on every website: `webmcp_list_tools` and `webmcp_execute_tool`.
- WebMCP observations retain the SDK's untrusted-data envelope and are labeled `source: webmcp`.
- Enmovil's Transformation component publishes all 16 existing page tools. An optional `NEXT_PUBLIC_WEBMCP_AGENT_ID` selects an isolated generic agent using only the two bridge callbacks. Without that variable, the existing Enmo configuration remains active.

## Website responsibilities

New websites can use the browser API directly; they do not need Convinced's registry or naming conventions:

```js
const lifecycle = new AbortController();
await document.modelContext.registerTool({
  name: 'show_product',
  description: 'Open the details of a product from the current catalog.',
  inputSchema: {
    type: 'object',
    properties: { productId: { type: 'string' } },
    required: ['productId'],
    additionalProperties: false,
  },
  execute: async ({ productId }, { signal }) => {
    // Validate productId, use the same controller as the human UI,
    // and return the final observed state. Do not return intent as success.
    return productController.openAndVerify(productId, { signal });
  },
}, { signal: lifecycle.signal });
// On route teardown: lifecycle.abort();
```

Prefer complete user actions over exposing every UI setter. The Enmovil trial exports all existing tools to test compatibility; it does not establish that all 16 should remain discoverable in production.

## Agent integration

For customer-controlled, persistent prompt edits, use [the authenticated agent management API](agent-prompt-management.md). It updates the SDK agent's active ElevenLabs branch and verifies provider persistence; it is separate from visitor-callable WebMCP tools.

The example below assumes your application supplies `applicationPolicy.authorize(tool, input)`. It is a policy hook, not a built-in SDK function.

```ts
import {
  getWebMcpModelContext, createWebMcpBridge,
  ClientToolRegistry, ConvincedClient, WEBMCP_VOICE_BINDINGS,
} from '@convinced/widget-sdk';

const modelContext = getWebMcpModelContext();
if (!modelContext?.getTools) throw new Error('WebMCP is unavailable in this browser');

const bridge = createWebMcpBridge({
  modelContext,
  origin: location.origin,
  // Supply the application's actual policy; annotations alone are not consent.
  authorize: (tool, input) => applicationPolicy.authorize(tool, input),
  argumentEncoding: 'json-string', // tested Chrome 152 interface
});
const client = new ConvincedClient({ orgSlug: 'your-org' });
await client.initialize({ loadMedia: false });
const voice = client.createVoiceController({
  tools: new ClientToolRegistry(bridge.tools),
  exactClientTools: WEBMCP_VOICE_BINDINGS,
  genericClientTool: false,
});
// On a visitor gesture: await voice.start();
// On explicit session close: await client.endSession(); bridge.dispose();
```

Convinced must configure the session to select the intended isolated agent, with those two client-tool schemas. Do not assume the organization default already uses WebMCP. Run `bun run export:webmcp:agent` to generate `artifacts/webmcp/elevenlabs-tools.json` and `agent-prompt.txt` directly from the SDK definitions. The exporter does not contact ElevenLabs. Upload the standalone client tools, attach their IDs to the experimental agent, and use the supplied generic prompt; the existing Enmovil prompt names legacy tools and cannot simply be reused unchanged.

For the local Enmovil trial, set `NEXT_PUBLIC_WEBMCP_AGENT_ID` before starting Next.js. Keep browser registration separate from microphone connection. The current Enmovil component is desktop-only, so native integration testing uses a 1440×1000 viewport. Extracting registration from that component is recommended before mobile rollout.

## Findings from real Chrome

The native run uses installed Chrome 152.0.7977.83 with `--enable-features=WebMCP --enable-blink-features=WebMCP`, an isolated browser profile, and no polyfill. The SDK voice callbacks run with an explicitly fake voice transport, while WebMCP registration, discovery, execution and page UI are real.

- All 16 Enmovil tools were discovered, their schemas retrieved, and calls routed through the two generic callbacks.
- A second local shop, authored directly against WebMCP, worked without Convinced-specific names or a ClientToolRegistry.
- The same adapter discovered Google's public pizza demo's seven tools, changed pizza size/style, and added three mushrooms visible in the DOM.
- Invalid arguments, unknown/stale controls, missing broader-knowledge consent/receipts, tool lifecycle changes, and leaving the route were exercised.
- An alternating 30-sample read benchmark measured approximately 0.2 ms median for direct native execution and 0.4 ms through the SDK voice callback bridge. This measures local dispatch only, excluding model inference, network, discovery turns and speech. See `native-results.json` for raw samples from the final run.
- The fixed SDK tool definitions total about 1.4 KB of JSON. Catalogs and individual schemas still consume context when discovered; this does not prove a total token-cost reduction.

### Bugs the experiment exposed

1. Chrome 152 returns input schemas and results as JSON strings, despite newer API examples using objects. The adapter accepts string/object schemas and parses native results. Execution encoding is explicit; mutations are never retried with a different signature. Newer-browser object-input mode has unit coverage, not a native-browser matrix yet.
2. The SDK rejects deeply nested result objects, which broke discovery of the guidance-options schema. Full schemas now travel as `input_schema_json`, preserving their content without exceeding the observation-depth cap. Catalog discovery is paginated.
3. The existing low-level Enmovil orchestration resolver returns `insufficient_evidence` for “Show orchestration” from the Leadership screen. The low-level capacity-role tool reports `not-found` / `brief_open: false` while selecting the role. Both reproduced through direct native calls without the SDK bridge.
4. The primary action tool can also return `verification_failed` after the handoff sequence: the orchestration action's observed active node drifts to `workforce-map`; the role action reports the overlay without confirmed visibility. These are retained as failing business-outcome checks. They must not be described to the visitor as successful navigation. Their root causes have not been fully diagnosed.

The raw report deliberately retains these failures and the runner exits nonzero when page-outcome checks fail. Successful transport and successful business outcomes are counted separately in the handoff summary. Do not quote a blanket “100% success” rate.

## Reproduce

In the SDK checkout:

```sh
bun install
bun run check
bun run export:webmcp:agent
WEBMCP_TEST_URL=http://localhost:4180/transformation WEBMCP_PUBLIC_DEMO=1 bun run test:webmcp:native
```

Set `WEBMCP_CHROME_PATH` when Chrome is installed elsewhere. Without `WEBMCP_TEST_URL`, the runner tests its independent local fixture. `WEBMCP_PUBLIC_DEMO=1` additionally tests Google's public demo and requires network access. The script produces raw JSON and screenshots in `artifacts/webmcp/`.

The historical website trial used `vendor/convinced-widget-sdk-0.1.1-webmcp.2.tgz` and `npm run dev -- --port 4180`. The client PR now migrates to `.3`. For the session fix, install the exact `.3` npm version, migrate the voice owner as above, and test against the hosted backend; changing the dependency alone does not migrate a standalone controller.

## What remains before production

- Live autonomous-model and voice comparison: the original SDK/site experiment had no provider credential and used a fake voice transport. A later customer-prompt test used the Convinced server credential to create, update, verify and delete a temporary ElevenLabs agent; that validates prompt persistence only. No real provider conversation was run. Spoken accuracy, interruption behavior, LLM action selection, and end-to-end latency remain unmeasured. Use an isolated agent and run the existing conversation corpus before routing traffic.
- Do not delete the old configuration until that comparison passes. Dynamic discovery trades static schemas for catalog/schema lookup turns; prompt selection and caching need evaluation.
- Test supported browsers and decide the deployment policy. Native WebMCP is experimental; Chrome offers an origin trial and a local flag. A JavaScript polyfill can make an embedded client work in other browsers, but does not create native browser-agent integration. No polyfill was installed or tested in this package.
- This version supports same-origin documents only. Cross-origin embedded widgets require a host-side bridge or explicit `tools` permissions policy plus origin exposure/discovery support. Those iframe flows were not implemented here.
- Page tools still own validation, permission checks, abort handling, and verified UI outcomes. Audit consequential operations with real application authorization; do not authorize them solely from tool annotations.
- Current observation, argument, and timeout bounds still apply. Very large schemas/results need bounded summaries or a follow-up design; this is not an unlimited relay.

## Research sources

- [WebMCP specification, draft of 10 September 2026](https://webmachinelearning.github.io/webmcp/): document-scoped browser API, tool registration and discovery.
- [Chrome WebMCP overview](https://developer.chrome.com/docs/ai/webmcp): availability, origin trial, flags and browser constraints.
- [Imperative API, updated 11 September 2026](https://developer.chrome.com/docs/ai/webmcp/imperative-api): `registerTool`, `getTools`, `executeTool`, `toolchange`, lifecycle and input-encoding changes.
- [Chrome evaluation guidance](https://developer.chrome.com/docs/ai/webmcp/evals): deterministic execution tests and probabilistic model-selection evals answer different questions.
- [Puppeteer WebMCP guide](https://pptr.dev/guides/webmcp): native-browser automation and experimental support.
- [ElevenLabs client tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools): browser callbacks must match provider tool configuration.
- [ElevenLabs MCP support](https://elevenlabs.io/docs/eleven-agents/customization/tools/mcp): HTTP/SSE server integration is distinct from accessing tools in a visitor's tab.
- [GoogleChromeLabs demos and polyfill](https://github.com/GoogleChromeLabs/webmcp-tools): independently authored compatibility target and an optional future fallback.

Research supports the architecture recommendation; the local report is the evidence for implementation behavior. Neither establishes universal browser compatibility or autonomous-agent reliability.

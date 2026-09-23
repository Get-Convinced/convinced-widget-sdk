# WebMCP website-tool handoff

Use one `ClientToolRegistry` as the website capability contract. The same registry powers typed Luna turns, spoken turns delegated through Luna, and WebMCP discovery.

```ts
const tools = new ClientToolRegistry([
  showSlideTool,
  openDemoFormTool,
  updateCalculatorTool,
])

const client = new ConvincedClient({
  orgSlug: 'acme',
  agentId: 'deployment_acme_site',
  tools,
  authorizeToolCall,
})

const publisher = client.publishToolsToWebMcp()

await publisher?.ready

// On route teardown:
publisher?.dispose()
```

A tool is a bounded capability, not arbitrary page scripting. Use a stable `host_` or `client_` name, an object JSON schema, an effect classification, a consent policy, a timeout, and a handler that returns what actually happened. Keep presentation decisions in the host UI.

`publishToolsToWebMcp()` reuses the client registry, session, and `authorizeToolCall` policy. The lower-level `publishRegistryToWebMcp()` remains available for hosts that deliberately manage those values themselves.

For chat, Luna receives the manifest from the Convinced backend. A requested host action is returned as an SSE call plus a signed continuation capability. The SDK verifies the call against the local registry, obtains host consent, executes it once, and posts the result. The backend verifies organization, session, turn, call ID, tool name, expiry, and model arguments before resuming Luna.

For speech, `gpt-live-1` delegates the utterance to the same Luna chat. Luna chooses the same registry tools, so a slide/form/page action has one implementation and one result. Live speaks the final Luna answer; it does not independently repeat the action.

Use `createWebMcpBridge()` only when the agent must discover same-origin tools registered elsewhere through the browser's WebMCP API. Most sites should publish their existing registry and pass that registry directly to `ConvincedClient`.

```ts
const bridge = createWebMcpBridge({
  modelContext: getWebMcpModelContext()!,
  origin: window.location.origin,
  authorize: (tool, input) => approveWebsiteAction(tool.name, input),
})

const client = new ConvincedClient({
  orgSlug: 'acme',
  agentId: 'deployment_acme_site',
  tools: bridge.tools,
})

// On route teardown:
bridge.dispose()
```

WebMCP is evolving and browser-dependent. Feature-detect it, dispose tools on route teardown, re-register route-specific tools after navigation, and retain the direct registry path. Test a second independently authored page before claiming the integration is generic.

Study:

- [WebMCP draft specification](https://webmachinelearning.github.io/webmcp/)
- [OpenAI Live delegation](https://developers.openai.com/api/docs/guides/live-delegation)
- [OpenAI Live API](https://developers.openai.com/api/docs/guides/live)

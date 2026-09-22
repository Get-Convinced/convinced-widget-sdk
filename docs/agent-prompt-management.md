# Customer-managed prompts

`ConvincedAgentAdmin` lets an authenticated customer administrator persistently update the Convinced SDK agent's system prompt and opening message. This is a management API, not a public widget capability.

```ts
const admin = new ConvincedAgentAdmin({
  orgSlug: 'acme',
  agentId: 'deployment_acme_site',
  apiBase: 'https://app.getconvinced.ai',
})

const current = await admin.getPrompt()
await admin.updatePrompt({
  systemPrompt: 'You are Acme’s implementation guide...',
  firstMessage: 'What are you trying to improve?',
  expectedRevision: current.revision,
})
```

Endpoints:

- `GET /api/org/:orgSlug/sdk-agents/:agentId/prompt`
- `PATCH /api/org/:orgSlug/sdk-agents/:agentId/prompt`

Both require an authenticated member with the `ADMIN` role. The server verifies that the Convinced `AgentDeployment` belongs to the organization. GET returns `{ source: 'convinced', agentId, systemPrompt, firstMessage, revision, updatedAt }`. PATCH accepts either editable field or both plus `expectedRevision`. A stale revision returns `409`; reload before retrying.

The save updates Convinced's prompt source used by new SDK sessions. It never exposes or asks the customer browser for an OpenAI key, model credential, provider agent ID, or tool configuration. Do not publish this API as WebMCP or a visitor tool.

`ConvincedAgentAdmin` uses `credentials: 'same-origin'`. Run it on the authenticated Convinced admin origin, or point `apiBase` to an authenticated same-origin management proxy on the customer's admin site. A public customer page cannot send its cookies to a different Convinced origin through this helper.

# Customer-managed ElevenLabs prompts

`ConvincedAgentAdmin` reads and persistently updates the ElevenLabs agent used by the customer's SDK. Its authenticated server API discovers the branch receiving live traffic, PATCHes that branch on ElevenLabs, and reads it again before reporting success.

This changes the provider configuration for subsequent unpinned conversations. Active conversations and explicit session prompt/version overrides can retain their existing configuration. The separate Convinced text-chat prompt and default widget configuration are not edited by this API.

## SDK use

Use this in an authenticated admin application. Do not register prompt administration as a visitor-callable WebMCP tool.

```ts
import { ConvincedAgentAdmin } from '@convinced/widget-sdk';

const agent = new ConvincedAgentAdmin({
  orgSlug: 'your-org',
  agentId: 'THE_SAME_AGENT_ID_USED_BY_THE_VOICE_SDK',
  apiBase: window.location.origin,
});

const current = await agent.getPrompt();
// Display current.systemPrompt and current.firstMessage in the editor.
const saved = await agent.updatePrompt({
  systemPrompt: systemPromptEditor.value,
  firstMessage: firstMessageEditor.value,
  expectedRevision: current.revision,
});
// Show Saved only after this resolves; retain saved.revision for the next edit.
```

`apiBase` must point to the Convinced backend implementing this API, or a trusted same-origin proxy exposing the same paths. Setting it to an arbitrary customer website does not install an API there. The default transport uses same-origin session cookies. A supplied `fetch` can route through a customer's authenticated management integration; it must not expose a provider key to the browser. Cross-origin browser writes to Convinced are rejected. Public widget tokens cannot edit prompts. This release does not introduce an external management API-key issuer.

## Backend setup

Deploy the accompanying Convinced app changes:

- `GET /api/org/:orgSlug/sdk-agents/:agentId/prompt`
- `PATCH /api/org/:orgSlug/sdk-agents/:agentId/prompt`
- PATCH body: `{ systemPrompt?, firstMessage?, expectedRevision }`. At least one editable field is required; omitted fields are preserved. An empty `firstMessage` is allowed.
- Result: `{ source: 'elevenlabs', agentId, systemPrompt, firstMessage, revision, branchId, versionId, trafficPercentage }`.

Both endpoints require an authenticated organization member with the `ADMIN` role. The server checks ownership using `AgentDeployment.voiceConfig.elevenlabsAgentId` or `externalAgentId`. Provision the dedicated SDK agent's ownership binding before use; knowing a public agent ID does not grant access. Agents bound to multiple organizations are refused. Keep dedicated SDK agents distinct from an organization's default widget agent; do not replace an unrelated binding to pass authorization.

The server reads `ELEVEN_API_KEY` or `ELEVENLABS_API_KEY`, with permission to read agents/branches and update the customer agents. Nothing returns that key to the SDK. GET reads ElevenLabs directly. This API does not maintain a second prompt store in Convinced; successful saves use the provider's version history.

Only the requested `conversation_config.agent.prompt.prompt` and/or `conversation_config.agent.first_message` fields are sent in the PATCH. The system prompt is limited to 100,000 UTF-8 bytes and the opening message to 10,000. Voice, model, tools and traffic allocation are omitted. The server verifies both prompt fields (including preservation of omitted values) and the live branch identity after saving. Mutations are never automatically retried.

## Branches and failures

ElevenLabs' default GET can return Main even when Main receives 0% of traffic. The API selects the sole branch receiving 100%. It refuses split/unknown traffic, archived live branches and incomplete listings (more than the first 100 results). It does not redeploy traffic or alter experiments.

`expectedRevision` hashes the provider agent, branch, version, prompt and first message. A stale editor gets HTTP 409 and must reload. This is a stale-edit check, not an atomic provider compare-and-swap: simultaneous changes through other servers or dashboards can still race. Read-back proves the observed state at verification time.

HTTP 502 can mean the provider applied an update but verification failed. Inspect `ConvincedApiError.code` and `.details.providerUpdate` (`not_attempted`, `unknown`, or `applied`, when available), reload, and show the observed state before retrying. A timeout is not evidence that the old prompt remains active.

## Validation on 14 September 2026

- SDK: 144 tests passed, including nine management checks; typecheck, build and packed-consumer checks passed.
- Backend: 16 integration tests passed using the real route and provider helper with controlled provider responses. Coverage includes live branch selection, read-back, narrow PATCH payload, administrator/tenant isolation, stale revisions, split traffic and failed writes/verifications.
- Existing widget suite: 50 files, 328 tests passed. Backend typecheck and changed-file lint passed.
- Real ElevenLabs: created a temporary private agent, updated its prompt through the new helper, read the changed prompt back independently, checked preserved settings, and deleted the temporary agent successfully. Raw evidence: `artifacts/webmcp/prompt-live-results.json` in the handoff.
- Real first-message persistence: opening-only, combined prompt/opener and empty-opener changes passed on a temporary private ElevenLabs agent; it was deleted with HTTP 204. Evidence: `artifacts/webmcp/first-message-live-results.json`.
- Real Enmovil read: discovered the branch receiving 100% of traffic and read its prompt. Main received 0%. No Enmovil production prompt was edited.

The management API is deployed. Each dedicated agent still requires a server-controlled ownership binding and authenticated organization ADMIN access; test those for the agent your integration selects. Public visitor credentials do not provide management access.

References: [ElevenLabs update agent](https://elevenlabs.io/docs/api-reference/agents/update), [agent versioning](https://elevenlabs.io/docs/eleven-agents/operate/versioning), [official OpenAPI schema](https://api.elevenlabs.io/openapi.json).

Study and implementation references are collected in the Mintlify `guides/widget-sdk/client-handoff.mdx` and `webmcp.mdx` pages included in the client handoff.

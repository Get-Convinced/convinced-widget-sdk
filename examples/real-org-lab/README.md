# Real organization voice lab

This localhost-only page exercises the published SDK surface against the real
Convinced dogfood organization and its `acme-robotics` campaign. It creates a
real Convinced session, uses a private ElevenLabs WebRTC token, links an opaque
visitor identity, records privacy-masked PostHog analytics, persists the
correlation into the internal dashboard, navigates a History API SPA, scrolls
and highlights allowlisted DOM targets, calls a bounded MCP-style tool, and
shows a real slide from the Convinced catalog. It also exercises the in-widget
demo-request fallback end to end: this records a request for team follow-up; it
does **not** reserve a calendar time.

## 1. Build the package

```bash
cd convinced-widget-sdk
bun install
bun run build
```

## 2. Provision a private test agent

Do not modify the dogfood or customer agent. Duplicate it, attach the exact 11
SDK tools, enable first-message overrides, and require signed sessions:

```bash
cd ../convinced-app/frontend

SOURCE_AGENT_ID=$(curl -sS \
  -H 'Origin: http://localhost:4184' \
  https://app.getconvinced.ai/api/widget/convinced/config \
  | jq -r .elevenLabsAgentId)

pnpm exec tsx scripts/e2e-elevenlabs-disposable-agent.ts \
  --source-agent-id="$SOURCE_AGENT_ID" \
  --profile=real-org-lab \
  --name="Convinced Widget SDK Real Org Lab" \
  --enable-auth
```

Copy `agentId` from the final `E2E_ELEVENLABS_STATE` line. Keep the entire state
for cleanup; the script never mutates the source agent.

## 3. Start the page

The server needs the ElevenLabs API key only to mint short-lived browser tokens.
The PostHog project token is public by design. You can load both from the app's
existing local server environment without copying them into the example:

```bash
cd convinced-widget-sdk

SAMPLE_ELEVENLABS_AGENT_ID="agent_from_step_2" \
bun --env-file=../convinced-app/frontend/.env.local run example:real
```

Open:

```text
http://localhost:4184/overview?c=acme-robotics
```

The server binds only to `127.0.0.1`, accepts only localhost Host headers,
proxies only the selected organization, binds the upstream Convinced session to
an HttpOnly `SameSite=Strict` cookie, verifies the signed session capability
when the connected deployment supplies one, and selects the private agent on
the server. Voice issuance also requires a same-origin request, has a bounded
quota, and applies a restrictive CSP and Permissions Policy.

To test an undeployed local backend, point only the Convinced API proxy at an
explicit loopback origin. HTTP is rejected for every non-loopback host and the
dashboard link remains HTTPS-only:

```bash
CONVINCED_API_BASE=http://127.0.0.1:3000 \
SAMPLE_ELEVENLABS_AGENT_ID="agent_from_step_2" \
bun --env-file=../convinced-app/frontend/.env.local run example:real
```

## 4. Manual acceptance path

1. Check both consent boxes and start the test.
2. On a fresh session, click **Run demo-request E2E**. The lab opens the real SDK form, submits a unique QA identity, requires the SDK identity state to match, then retries the same request and requires the backend to return the same opaque `requestId` and `visitorId` with `alreadySubmitted: true`.
3. Confirm **Demo request** reads `Received` and explicitly says follow-up is pending rather than implying a calendar booking.
4. Use **Test identity linking** with a business email, or let the managed voice identity enquiry appear conversationally.
5. Open voice, hold push-to-talk, and say “Take me to security and highlight the controls.”
6. Say “Show me the AI Sales Engineer proof slide.”
7. Say “Check the Acme account readiness tool.”
8. End and persist the session.
9. Open **Internal dashboard** and confirm identity, the opaque demo-request correlation, behavior events, slide/tool activity, and the ElevenLabs conversation ID.
10. Open **PostHog replay** and confirm navigation/highlights are visible while identity, transcript, form, and trace surfaces are blocked. With analytics consent, the SDK bridge emits only non-PII `widget.demo_opened`, `widget.demo_submitted`, and `widget.demo_failed` lifecycle properties.
11. Reload, identify with the same email, and confirm the SDK reuses its opaque organization-scoped return-visitor key.

The E2E button performs a real durable write and is intentionally disabled after
one request in a session. Reload before repeating it. A successful result means
the request is stored, linked to visitor identity, and queued for configured
team follow-up. It still does not mean that a calendar slot has been booked.

The page exposes `window.__realOrgLab` for browser automation, including
`runDemoRequestE2E()`, safe request correlation, and the names of demo events
emitted at PostHog's `before_send` boundary. That browser hook proves SDK
emission, not warehouse ingestion; the project E2E verifies successful ingest
proxy responses separately. The page intentionally does not expose an ElevenLabs API key, a
PostHog personal API key, raw test identity values, transcript data in the safe
trace, or arbitrary DOM/MCP execution.

## 5. Clean up the test agent

```bash
cd ../convinced-app/frontend

pnpm exec tsx scripts/e2e-elevenlabs-disposable-agent.ts \
  --cleanup-agent-id="agent_from_step_2" \
  --cleanup-tool-ids="comma_separated_createdToolIds"
```

If `createdToolIds` is empty, omit `--cleanup-tool-ids`. Stop the local lab
server when testing is complete.

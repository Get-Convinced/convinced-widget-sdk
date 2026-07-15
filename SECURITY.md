# Security

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/Get-Convinced/convinced-widget-sdk/security/advisories/new) or email [hi@getconvinced.ai](mailto:hi@getconvinced.ai) with enough information to reproduce the problem safely.

Include the affected SDK version, browser/runtime, impact, reproduction steps, and any suggested mitigation. Do not include real visitor data, active credentials, session capabilities, or customer secrets.

## Supported releases

Security fixes target the latest published minor release. Upgrade to the latest version before reporting behavior that may already be fixed.

## Browser security boundary

The SDK is intentionally a browser adapter. It must never receive long-lived ElevenLabs API keys, PostHog personal API keys, Convinced partner keys, privileged MCP credentials, database credentials, or server session secrets. Use short-lived voice credentials, opaque signed Convinced session capabilities, explicit tool allowlists, and visitor consent.

DOM, custom, and MCP-backed tools are denied unless they are registered and authorized. Treat page content, campaign context, transcripts, and tool results as untrusted data. Review the security section in the README before enabling navigation, mutation, page context, identity, analytics, or replay.

## Release integrity

Releases are built and tested on GitHub-hosted runners. After the bootstrap release, npm publication uses OpenID Connect trusted publishing without a long-lived repository token and produces npm provenance linked to the public source repository. The package includes notices for third-party code bundled into the standalone browser build.

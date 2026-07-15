# Releasing `@convinced/widget-sdk`

The source repository and npm package are public. GitHub Releases are the release control plane: a published release whose tag matches `package.json` starts `.github/workflows/publish.yml`.

## One-time npm bootstrap

GitHub organization access does not grant npm scope access. Before the first release, an npm owner must bootstrap the package once from a reviewed local checkout:

1. Sign in with `npm login` and confirm `npm whoami` succeeds.
2. Verify that the account can publish public packages in the `@convinced` scope. If the scope is not controlled by Convinced, stop and rename the package and documentation together before publishing anything.
3. From the exact commit pushed to public `main`, run `bun install --frozen-lockfile`, `bun run check`, and inspect `npm pack --dry-run --ignore-scripts`.
4. Remove every old `.tgz` from the checkout. Publish the reviewed working tree with the current npm CLI: `npx npm@11.18.0 publish --access public`. Do not publish a previously generated archive.
5. Verify the public version, README, declarations, and browser bundle from a clean registry install.

Immediately after the first package exists:

1. Configure npm trusted publishing with the exact values `Get-Convinced`, `convinced-widget-sdk`, `publish.yml`, and environment `npm`. With npm 11.18.0, this can be done with `npm trust github @convinced/widget-sdk --repository Get-Convinced/convinced-widget-sdk --file publish.yml --environment npm --allow-publish`.
2. Keep no npm publish token in GitHub. The release workflow intentionally has no `NODE_AUTH_TOKEN` and publishes only through GitHub OIDC.
3. Enable npm account and organization 2FA controls. Configure the GitHub `npm` environment and repository release permissions so only approved maintainers can publish releases.
4. Run the next release through the trusted publisher and confirm npm displays provenance linked to this public repository.

Trusted publishing requires a GitHub-hosted runner, Node.js 22.14 or newer, npm 11.5.1 or newer, and `id-token: write`. The workflow pins current action revisions and npm 11.18.0.

## Normal release

1. Update `package.json` to the intended semantic version and update release notes.
2. Run `bun install --frozen-lockfile` and `bun run check`.
3. Inspect `npm pack --dry-run --ignore-scripts`. The package check also installs the tarball into a clean consumer, compiles it with TypeScript Bundler and NodeNext resolution, imports it with Node and Bun, audits runtime dependencies, and enforces the file and size budgets.
4. Merge the reviewed change to `main`.
5. Create a signed `v<package-version>` tag from that commit and publish the matching GitHub Release.
6. Watch the publish workflow, then verify the version, provenance, README, declarations, and browser bundle on npm.

The workflow refuses release commits that are not contained in `origin/main`, and event-controlled tag text never enters a shell program directly. Protect `main`, protect release tags, and keep the `npm` GitHub environment restricted to approved maintainers.

Never reuse a version. npm versions are immutable, and the workflow refuses to publish a version that already exists. The one-time manually bootstrapped version should be tagged and pushed, but it should not be published again as a GitHub Release.

## Publication boundary

The npm tarball contains the built ESM module, TypeScript declarations, standalone browser bundle, third-party notices, public examples, README, license, and the coding-agent prompt. It excludes source tests, the real-organization lab, local environments, credentials, generated archives, and internal QA output.

Official npm references:

- [Trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements/)
- [Publishing scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)

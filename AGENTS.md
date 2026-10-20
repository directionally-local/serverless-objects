# AGENTS.md

Guidance for agents working in this repository. Prefer the checked-in code and tests over assumptions; this project is pre-alpha and its runtime limitations are documented in the README.

## 1. Project

- The M0 celld spike passed its documented runtime gate, but unmodified Wrangler config support is not established and the full Agents SDK sample has not been run through this CLI.
- ACME HTTP-01 issuance is implemented and verified only against a local Pebble server; public Let's Encrypt issuance/renewal is unverified. Point-in-time restore is not available on celld 0.6. Roadmap targets are not implemented guarantees. The native engine remains planned, not shipped.
- Conformance v0 (`packages/conformance`) passes 10/10 cases on Wrangler 4.150.0 and celld 0.6.2; WebSocket hibernation and facets are not covered. Nothing is published to npm yet.

Serverless Objects is a self-hostable operating layer for Cloudflare Workers and Durable Objects applications, aimed at coding-agent infrastructure. It is JavaScript (ES modules) on Node.js >=22, managed with npm workspaces; the current product is the `sobjects` CLI (workspace package `serverless-objects`). The CLI supervises the external celld Workers-compatible runtime (currently pinned to v0.6.2); it does not implement the Workers runtime. Cloudflare Workers/Wrangler APIs are the compatibility contract. The dashboard is plain HTML/CSS/JS; there is no application framework or TypeScript codebase. Status: pre-alpha / v0.1 CLI test candidate.

## 2. Build / test / run

Run from the repository root unless a command says otherwise. Node.js 22+ is required.

| Purpose | Command | Notes |
|---|---|---|
| Install exactly from lockfile | `npm ci` | Standard setup; requires npm and Node >=22. |
| All automated tests | `npm test` | Runs each workspace's test script; CI uses this. |
| CLI workspace tests | `npm run test --workspace=serverless-objects` | Node built-in test runner over `packages/cli/test/*.test.js`. |
| Conformance (Wrangler) | `npm run test:wrangler --workspace=sobjects-conformance` | Runs the conformance app under pinned `wrangler dev`; CI runs this. |
| Conformance (celld) | `npm run test:celld --workspace=sobjects-conformance` | Runs the same cases against celld, including an alarm across a restart; not run in CI. |
| CLI help | `npm exec --workspace=serverless-objects -- sobjects --help` | Uses the workspace CLI entry point. |
| Local project development | `npm exec --workspace=serverless-objects -- sobjects dev [project]` | Runs a Wrangler-compatible project with celld; needs a project/config and may install the pinned engine. |
| Deploy a project | `npm exec --workspace=serverless-objects -- sobjects deploy [project]` | Forwards deploy options to celld; needs project and object-store setup. |
| First local node setup | `cp sobjects.example.toml sobjects.toml`, edit the bucket, then `npm exec --workspace=serverless-objects -- sobjects up` | `sobjects.toml` is intentionally git-ignored. The first `up` may download/verify celld and needs bucket credentials via celld's credential chain or environment. |
| Detached node | `npm exec --workspace=serverless-objects -- sobjects up --detach` | Stores service state/logs under the user state directory. |
| Lifecycle | `npm exec --workspace=serverless-objects -- sobjects status`; `npm exec --workspace=serverless-objects -- sobjects logs`; `npm exec --workspace=serverless-objects -- sobjects down` | Inspect or stop a detached node. |
| OS service unit | `npm exec --workspace=serverless-objects -- sobjects service install` | Generates a systemd/launchd unit; does not enable or start it. |
| Production build | None | No build/bundle script: package is plain ESM. `prepublishOnly` runs tests. |
| Watch, lint, format, type-check | None configured | No watch/lint/format/type-check scripts or TypeScript config. Edit and run tests directly. |

CI: `.github/workflows/ci.yml` runs `npm ci`, `npm test` and the Wrangler conformance run on Ubuntu/Node 22 for pushes to `main` and pull requests; no matrix or deployment job. `release-please.yml` runs on `main` to manage release PRs/releases. When it creates a CLI release, its `publish-npm` job tests the tag and publishes `serverless-objects` to npm through trusted publishing (OIDC, no token) with provenance. Publish an existing tag with `gh workflow run release-please.yml -f tag=serverless-objects-vX.Y.Z`. Versions already on npm are skipped. Keep publishing in this one file: npm's trusted-publisher setting names it.

## 3. Layout

| Path | Why it lives here |
|---|---|
| `package.json`, `package-lock.json` | Root npm workspace and reproducible dependency graph; workspaces are `packages/*`. |
| `packages/cli/bin/sobjects.mjs` | Published executable shim; delegates to the CLI implementation. |
| `packages/cli/src/` | CLI, config parsing, engine/service lifecycle, ingress, admin/inspection, Wrangler preparation; modules are split by responsibility. |
| `packages/cli/src/dashboard/` | Static dashboard assets served by the admin surface, kept separate from server-side modules. |
| `packages/cli/test/` | Node test-runner tests grouped by implementation module, plus TLS fixtures. |
| `packages/cli/package.json` | Publishable CLI workspace metadata, executable mapping, runtime dependencies and test script. |
| `packages/hotcell/` | `@serverless-objects/hotcell`: Sandbox SDK 0.x-shaped Durable Object over `@hotcell/sdk`; logic in `src/sandbox.js`, DO glue in `src/index.js`. |
| `packages/autopilot/` | `@serverless-objects/autopilot`: `RunObject`/`RunRegistry`. Runtime-independent logic in `run-store.js`, `run-host.js` and `registry-store.js` over an `{exec, transaction}` SQL adapter; tests use `node:sqlite`. |
| `examples/` | Runnable Wrangler projects (not workspaces) that import the packages through the root `node_modules`. |
| `packages/conformance/` | Private workspace: conformance Worker app (`app/`), runner (`src/run.js`) for Wrangler and celld, and runner tests. |
| `sobjects.example.toml` | Safe starter configuration; copy to the ignored, machine-specific `sobjects.toml`. |
| `docs/conformance/` | Recorded Workers/celld compatibility findings (`m0-celld.md`) and conformance results (`results.md`); consult before changing runtime assumptions. |
| `docs/install.md`, `docs/porting-from-cloudflare.md`, `docs/compatibility.md` | User guides and the supported/unsupported table; keep them in step with conformance results. |
| `release-please-config.json`, `.release-please-manifest.json` | Release Please setup for `packages/cli`; `bump-minor-pre-major` keeps breaking changes below 1.0. |
| `private/` | Private strategy/planning material, explicitly ignored; do not add or commit it. |
| `.github/workflows/` | CI tests, Release Please, and npm publishing. |

## 4. Conventions

- Use native JavaScript ESM. The CLI workspace has `"type": "module"`; use `.js` for source/tests and `.mjs` for the executable shim. Imports use built-in `node:` specifiers and explicit relative `.js` extensions; there is no alias/path mapping.
- Existing style uses double-quoted strings, semicolons, two-space indentation, `camelCase` functions/variables and `UPPER_SNAKE_CASE` constants. There are no TS types/interfaces or configured type-strictness rules; avoid introducing TypeScript-only assumptions.
- Keep related behavior in its focused module (for example, engine protocol details in `celld-adapter.js`, ingress routing in `ingress.js`, config validation in `config.js`). Config parsers deliberately reject unknown keys.
- Tests are named `<area>.test.js` under `packages/cli/test/` and use Node's built-in `node:test` and `node:assert/strict`. Use temporary directories with cleanup and dependency injection for process/network boundaries; no external mock framework is configured.
- Commit history follows Conventional Commits, commonly `feat(cli): ...`, `fix(cli): ...`, `docs: ...` and `build: ...`. README asks contributors to sign off commits with `git commit -s` (DCO).
- `main` is the default branch; observed work uses short-lived `feat/*` and `docs/*` branches. Prefer focused branches/PRs rather than direct default-branch changes.
- No `.editorconfig` or `CONTRIBUTING.md` was found. README is the contribution/status guide. Root test script delegates to workspace scripts, so add new package tests to that package's script if introducing a workspace.

- Tests exercise local filesystem, HTTP/TLS and process boundaries with fixtures/test doubles; CI does not provision an external bucket or celld service.

## 5. Dependencies

- Use npm workspaces and commit the matching `package-lock.json` update. Add CLI runtime dependencies with `npm install --workspace=serverless-objects <package>`; use `--save-dev` for tools used only in development/tests. Keep root tooling out of runtime dependencies.
- CLI runtime dependencies: `jsonc-parser`, `smol-toml`, and for ACME `jose`, `@root/csr`, `@root/keypairs`, `@root/encoding`; tests use Node built-ins. The conformance workspace pins `wrangler` exactly as a dev dependency. Avoid adding dependencies for functionality available in supported Node versions.
- Examples: runtime package `npm install --workspace=serverless-objects <package>`; test/build-only tool `npm install --workspace=serverless-objects --save-dev <package>`. Keep the root lockfile synchronized.
- No bundler/native dependency pipeline exists. Keep celld as an external executable: `engine.js` pins its version and SHA-256 asset checksums, installs/verifies it at runtime, and supports `SOBJECTS_CELLD_BIN` for an existing binary. Do not bundle or bypass verification of it.
- Package dependency ranges currently use npm semver ranges (for example `^`) with the lockfile providing reproducibility; the engine version is exact and checksum-pinned. Preserve that distinction and update checksums when intentionally changing celld.

## 6. Do / Don't

1. Never commit credentials, real `sobjects.toml` files, private TLS keys/certificates, access tokens, or private planning files. Keep object-store credentials in celld's supported credential chain/environment, not TOML; inspect staged files before committing.
2. Keep celld's unauthenticated operator/admin listeners on loopback. The admin API has no authentication; do not expose it publicly. Non-loopback ingress requires TLS configuration. Treat forwarded client headers as untrusted and preserve the ingress behavior that replaces them with peer-derived values.
3. Preserve checksum verification and the pinned celld release metadata when changing installation/upgrade logic. Never silently accept an unverified engine binary.
4. Treat Cloudflare Workers/Wrangler semantics as the contract. Keep engine-specific behavior isolated and use conformance evidence/tests when changing compatibility behavior; do not claim celld parity that has not been tested.
5. Keep generated/local config and artifacts out of commits (`sobjects.toml`, `node_modules/`, `dist/`, `coverage/`, `.celld/` and generated Wrangler files are ignored).
6. Do not assume a separate build, formatter, linter, or TypeScript check exists. Add/adjust tests and run `npm test` instead of inventing untracked generated output.
7. Avoid broadening accepted config keys without validating semantics and updating focused tests; rejecting unknown settings is an intentional safety feature, not parser inconvenience.
8. Do not delete bucket/object data or service state as a routine cleanup. Durable Object state is persistent and separate from disposable test temp directories.
9. Preserve loopback defaults and security boundaries in config validation; ports such as celld's operator listener must not become accidentally reachable from the network.
10. Keep celld as a separately managed process and the admin/dashboard as a local control plane; do not move external-engine concerns into application object code.

## 7. Debugging & Troubleshooting

- Run the CLI under Node's inspector, e.g. `node --inspect-brk packages/cli/bin/sobjects.mjs status` (replace `status` with the command/arguments to debug). There is no custom debug script.
- Detached service state/logs default to `$XDG_STATE_HOME/serverless-objects` or `~/.local/state/serverless-objects`; override the directory with `SOBJECTS_STATE_DIR`. Use `sobjects status`, `sobjects logs`, `sobjects logs --supervisor` and `sobjects down` rather than managing PIDs by hand. celld's detached log is `celld.log`; ingress access logging is configured separately via `[ingress].access_log`.
- If installation/tests fail on unsupported syntax or APIs, confirm Node >=22, then run `npm ci` from the root. CI is the canonical test environment.
- `sobjects up` needs a valid `[celld]` bucket URI in `sobjects.toml` and storage credentials outside the file. First use needs network access to fetch the pinned celld release unless `SOBJECTS_CELLD_BIN` points to a binary.
- For deploy/build asset errors, inspect Wrangler config and project dependencies. If Vite is declared, the CLI runs `vite build` and requires one unambiguous generated `index.html` under the supported output locations; set `assets.directory` explicitly if discovery is ambiguous. Some Wrangler-only keys are intentionally rejected or normalized for celld.
- There is no clean script. `npm ci` reconstructs dependencies from the lockfile; stop detached services with `sobjects down`. Remove only confirmed disposable generated files, and never erase bucket-backed object data as a reset shortcut.

- `sobjects dev` intentionally skips ingress; the TLS/forwarded-header request path is exercised through `sobjects up` with ingress configured.
- Detached PID/log metadata under the user state directory is operational state, separate from Durable Object data persisted in the configured bucket.
- Ingress uses static PEM certificates (`[ingress.tls]`; `SIGHUP` reloads them) or ACME HTTP-01 (`[ingress.acme]`, `src/acme.js`) served on the `redirect_http` listener, with certificates stored under the state directory. ACME covers exact hostnames only; wildcards need static certificates. Test ACME locally against Pebble. Access logs may go to the state directory, a configured path, or stdout (`-`), and omit query strings.

## 8. Architecture Notes

- Entry flow: `packages/cli/bin/sobjects.mjs` calls the exported `run()` command dispatcher in `src/cli.js`. The dispatcher coordinates config, engine, service, ingress and project preparation modules; injected process/network dependencies make orchestration testable.
- `config.js` parses/validates `sobjects.toml`; `wrangler.js` checks/transforms project Wrangler config and discovers/builds static assets. `engine.js` downloads and verifies celld; `service.js` records detached PIDs/log paths and handles lifecycle; `units.js` generates systemd/launchd units.
- celld runs as a separate process and implements the Workers/Durable Objects runtime. Apps run through its dev/deploy flows; object state is persisted by the engine to a configured S3/GCS/Azure-compatible bucket. Serverless Objects supplies the operating layer, not a replacement runtime.
- The optional TLS ingress routes hostnames and WebSocket traffic to celld. The loopback admin API calls the celld adapter for node/object/storage information; a deploy-time inspector hook enables object storage inspection. The static dashboard consumes that local admin surface. The admin/operator APIs are unauthenticated and must stay loopback-only.
- There is no Docker/Compose, Nx/Turborepo, generated-code, or general build-transform setup in this repository. Vite building is only performed for a user's Wrangler project when asset discovery requires it; it is not a build of this CLI.

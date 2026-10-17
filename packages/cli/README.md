# serverless-objects

The `sobjects` CLI package for Serverless Objects.

## Current commands

- `sobjects dev [project] [celld dev options]` runs a local project with `celld dev`.
- `sobjects deploy [project] [celld deploy options]` forwards a deployment to celld.
- `sobjects --help` and `sobjects --version` show CLI help and version.

The CLI currently requires celld `v0.6.2` on `PATH`, or an explicit path in
`SOBJECTS_CELLD_BIN`. `dev` adds the project's `node_modules/.bin` to the child
`PATH`, so a project-local esbuild can be used. Deployments require celld's
normal bucket and credential configuration.

The `up` installer, config validation/normalization, and supervised engine
lifecycle are not implemented yet. The npm package is not published.

Requires Node.js 22 or newer. See the [project README](../../README.md) for the
product scope and roadmap.

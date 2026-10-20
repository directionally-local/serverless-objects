# Changelog

## [0.6.1](https://github.com/sinameraji/serverless-objects/compare/serverless-objects-v0.6.0...serverless-objects-v0.6.1) (2026-10-20)


### Bug Fixes

* **cli:** start the native engine when the backup bucket is unreachable ([5cb8c9b](https://github.com/sinameraji/serverless-objects/commit/5cb8c9b39518fe94325fcdd069c9fd3c8a31a6ac))

## [0.6.0](https://github.com/sinameraji/serverless-objects/compare/serverless-objects-v0.5.0...serverless-objects-v0.6.0) (2026-10-20)


### Features

* **cli:** run the native engine on worker threads ([06c5f79](https://github.com/sinameraji/serverless-objects/commit/06c5f79a06e7e63135679427b9ebcf7a20e83c50))

## [0.5.0](https://github.com/sinameraji/serverless-objects/compare/serverless-objects-v0.4.0...serverless-objects-v0.5.0) (2026-10-20)


### Features

* **cli:** back up native-engine objects to an S3-compatible bucket ([292d833](https://github.com/sinameraji/serverless-objects/commit/292d8335dd6e49001b4b1509fb31acaf2eb72dc7))

## [0.4.0](https://github.com/sinameraji/serverless-objects/compare/serverless-objects-v0.3.0...serverless-objects-v0.4.0) (2026-10-20)


### Features

* **cli:** load npm packages from node_modules in the native engine ([cd02995](https://github.com/sinameraji/serverless-objects/commit/cd02995de0d787b408b160ba82ff252a9c80ef4b))
* **cli:** run Autopilot in-process inside a native-engine object ([7d42a57](https://github.com/sinameraji/serverless-objects/commit/7d42a57f16ef5b08cb837d2969f6121b4e44c8e3))

## [0.3.0](https://github.com/sinameraji/serverless-objects/compare/serverless-objects-v0.2.0...serverless-objects-v0.3.0) (2026-10-20)


### Features

* **cli:** add `sobjects build --strict` to check portability to Cloudflare ([6596187](https://github.com/sinameraji/serverless-objects/commit/6596187f3300b8ec54ed2cddf66dd09556578267))
* **cli:** add the native engine's Durable Object core ([f811516](https://github.com/sinameraji/serverless-objects/commit/f81151689acc4b1b366fdf56e56842b189863ec9))
* **cli:** add WebSockets and the hibernation API to the native engine ([8d98a71](https://github.com/sinameraji/serverless-objects/commit/8d98a71dbb93d22ff51ec4e2e9f5c1ffc2ab01f3))
* **cli:** evict idle objects in the native engine ([4fe1365](https://github.com/sinameraji/serverless-objects/commit/4fe1365989421dfa124ffacb38d92213c1b3e970))


### Bug Fixes

* **cli:** recognize prefix-only built-ins on every Node version ([077db19](https://github.com/sinameraji/serverless-objects/commit/077db191952c4b9e81ae66b24cb93374090db34c))

## [0.2.0](https://github.com/sinameraji/serverless-objects/compare/serverless-objects-v0.1.2...serverless-objects-v0.2.0) (2026-10-20)


### Features

* **cli:** ship the Hotcell binding and Autopilot run objects in serverless-objects ([218cc5e](https://github.com/sinameraji/serverless-objects/commit/218cc5e611cbd1d769f2ce95c5ab881d4bc8ba5d))

## [0.1.2](https://github.com/sinameraji/serverless-objects/compare/serverless-objects-v0.1.1...serverless-objects-v0.1.2) (2026-10-20)


### Bug Fixes

* **cli:** read the default sobjects.toml from SOBJECTS_CONFIG ([c4d12ba](https://github.com/sinameraji/serverless-objects/commit/c4d12ba99f1f24e59ea6a5bd91b92184cee65b9b))

## [0.1.1](https://github.com/sinameraji/serverless-objects/compare/serverless-objects-v0.1.0...serverless-objects-v0.1.1) (2026-10-19)


### Documentation

* install the CLI from npm ([ba731a5](https://github.com/sinameraji/serverless-objects/commit/ba731a5e4a027f2ff2d34c8409db7e9cef46d322))

## 0.1.0 (2026-10-19)


### Features

* add conformance v0 and ACME ingress ([d84e675](https://github.com/sinameraji/serverless-objects/commit/d84e675da5c5b7dd1bf65965a2ac7f0f09a57d57))
* add conformance v0 and ACME ingress ([1a1c5ad](https://github.com/sinameraji/serverless-objects/commit/1a1c5ad0b2fba6e89d497f87ec0722afb7628b40))
* **cli:** add celld adapter, loopback admin API, and metrics ([74ae121](https://github.com/sinameraji/serverless-objects/commit/74ae1211aefc6e2318a1fce347ff60323f733803))
* **cli:** add checksum-pinned celld upgrades with rollback ([9f48a2f](https://github.com/sinameraji/serverless-objects/commit/9f48a2f45d32d0620cb0fc906886582a6b993e5c))
* **cli:** add the loopback dashboard ([91e83a7](https://github.com/sinameraji/serverless-objects/commit/91e83a74b5aaf9bfe2f0a0434742f60db942cae9))
* **cli:** add TLS ingress proxy with hostname routing ([c837f0d](https://github.com/sinameraji/serverless-objects/commit/c837f0d9f29d5c5322f1e88e0c497ad7368c4531))
* **cli:** bootstrap the v0.1 sobjects package ([8d211f5](https://github.com/sinameraji/serverless-objects/commit/8d211f58b33c001fab524b99f693212aae8b0d06))
* **cli:** generate systemd and launchd units ([fed5d78](https://github.com/sinameraji/serverless-objects/commit/fed5d78f20b903f6caedd27ce9e6d0969c2aac20))
* **cli:** inspect Durable Object storage through deploy-time hooks ([fc702bc](https://github.com/sinameraji/serverless-objects/commit/fc702bc8c20f43141b7e9cd802b5ec162929eeb0))
* **cli:** install pinned celld and add up ([ea604a2](https://github.com/sinameraji/serverless-objects/commit/ea604a25925b4b0721e7975565da4840041ce7cb))
* **cli:** load deploy defaults from sobjects.toml ([ca60bbb](https://github.com/sinameraji/serverless-objects/commit/ca60bbb171325880d3ba43988915993417ce02d8))
* **cli:** manage detached celld processes ([a7ec8f8](https://github.com/sinameraji/serverless-objects/commit/a7ec8f8e75da42cb769800829dfc4f74c4ebf508))
* **cli:** parse [ingress] settings in sobjects.toml ([6feb12b](https://github.com/sinameraji/serverless-objects/commit/6feb12b320c30066303a9bd0a6179a3603c31840))
* **cli:** preflight Wrangler configs for celld ([3859271](https://github.com/sinameraji/serverless-objects/commit/3859271cc0a02387783ce384c3fd25e2cedfbf38))
* **cli:** run the ingress from up and manage it as a service ([b8e5cb0](https://github.com/sinameraji/serverless-objects/commit/b8e5cb095ead1e8c1b04c48e6dc606877f6b9b15))
* **cli:** show retained backup epochs and export objects as JSON ([8893a36](https://github.com/sinameraji/serverless-objects/commit/8893a36d323bd060c908d348f31c1347bdd993fa))
* **cli:** support Vite-generated assets ([1868ba9](https://github.com/sinameraji/serverless-objects/commit/1868ba9144fdd487a769e45c9e54304ae0835b12))
* **cli:** wrap celld dev and deploy ([b642f00](https://github.com/sinameraji/serverless-objects/commit/b642f00411a2650e034ca1efebf47c17bad975c7))


### Bug Fixes

* **cli:** bundle esbuild so deploy works from an npm install ([7988c68](https://github.com/sinameraji/serverless-objects/commit/7988c68b9fd3e007de765d5136a154d1839dbe5d))
* **cli:** keep Durable Object class names in inspector wrappers ([7be6aaa](https://github.com/sinameraji/serverless-objects/commit/7be6aaa16d2b4d2fcaf61a9887d8db2fe0b9ee77))
* **cli:** trust ingress forwarded headers and wait for celld to drain ([dbaa69a](https://github.com/sinameraji/serverless-objects/commit/dbaa69a4438188dea5e86f95117e0632862943d5))

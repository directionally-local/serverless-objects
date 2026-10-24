#!/usr/bin/env node
import { run } from "../src/cli.js";
import { brotliRuntimeAdvisory } from "../src/runtime-advisory.js";

const advisory = brotliRuntimeAdvisory();
if (advisory) process.stderr.write(`sobjects: warning: ${advisory}\n`);

process.exitCode = await run();

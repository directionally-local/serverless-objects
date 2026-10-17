import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { normalizeWranglerConfig, prepareWranglerProject } from "../src/wrangler.js";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-wrangler-test-"));
  directories.push(directory);
  return directory;
}

test("parses JSONC and strips only non-runtime observability metadata", () => {
  const result = normalizeWranglerConfig(`{
    // Wrangler comments and trailing commas are valid.
    "name": "chat",
    "main": "src/index.ts",
    "observability": { "enabled": true },
    "upload_source_maps": true,
  }`);

  assert.equal(result.config.name, "chat");
  assert.equal(result.config.main, "src/index.ts");
  assert.equal("observability" in result.config, false);
  assert.equal("upload_source_maps" in result.config, false);
  assert.equal(result.warnings.length, 2);
  assert.equal(result.changed, true);
});

test("rejects unsupported Wrangler keys before launching celld", () => {
  assert.throws(
    () => normalizeWranglerConfig('{"name":"chat","main":"src/index.ts","routes":[]}'),
    /Unsupported Wrangler config keys for celld.*routes/,
  );
});

test("extracts and removes a supported build.command for the CLI to run", () => {
  const result = normalizeWranglerConfig(`{
    "name": "chat",
    "main": "src/index.ts",
    "build": { "command": "npm run build" }
  }`);
  assert.equal(result.buildCommand, "npm run build");
  assert.equal("build" in result.config, false);
  assert.equal(result.changed, true);
});

test("rejects unsupported nested build options and asset configs without a directory", () => {
  assert.throws(
    () => normalizeWranglerConfig('{"name":"chat","main":"src/index.ts","build":{"command":"npm run build","watch_dir":"src"}}'),
    /Unsupported Wrangler build keys.*watch_dir/,
  );
  assert.throws(
    () => normalizeWranglerConfig('{"name":"chat","main":"src/index.ts","assets":{"run_worker_first":["/agents/*"]}}'),
    /assets.directory/,
  );
});

test("creates a temporary normalized config beside the project and removes it", async () => {
  const cwd = await temporaryDirectory();
  const project = join(cwd, "app");
  await mkdir(project);
  await writeFile(
    join(project, "wrangler.jsonc"),
    '{"name":"chat","main":"src/index.ts","observability":{"enabled":true}}',
  );

  const prepared = await prepareWranglerProject(["./app", "--port", "9876"], { cwd });
  assert.equal(prepared.args[1], "--port");
  assert.equal(prepared.args[2], "9876");
  assert.match(prepared.args[0], /^.*\.sobjects-wrangler-.*\.json$/);
  const normalized = JSON.parse(await readFile(prepared.args[0], "utf8"));
  assert.equal("observability" in normalized, false);
  assert.equal(prepared.warnings.length, 1);
  await prepared.cleanup();
  await assert.rejects(access(prepared.args[0]));
});

test("passes projects without Wrangler config through unchanged", async () => {
  const cwd = await temporaryDirectory();
  const args = ["./app", "--port", "9876"];
  const prepared = await prepareWranglerProject(args, { cwd });
  assert.deepEqual(prepared.args, args);
  assert.equal(prepared.warnings.length, 0);
  await prepared.cleanup();
});

test("reports JSONC parse errors with a source location", () => {
  assert.throws(
    () => normalizeWranglerConfig('{\n  "name": "chat",\n  "main": ,\n}', "worker.jsonc"),
    /Invalid Wrangler config worker.jsonc:3:/,
  );
});

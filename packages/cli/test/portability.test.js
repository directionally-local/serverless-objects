import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { analyzeProject, classifyImport } from "../src/portability.js";
import { readProjectConfig } from "../src/native/project.js";
import { run } from "../src/cli.js";

const directories = [];
after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));

const COMPAT = { compatibility_date: "2026-02-24", compatibility_flags: ["nodejs_compat"] };

test("Node.js built-ins are classified against Cloudflare's nodejs_compat support", () => {
  assert.deepEqual(classifyImport("node:crypto", COMPAT), { portable: true });
  assert.deepEqual(classifyImport("stream/promises", COMPAT), { portable: true });
  assert.match(classifyImport("node:child_process", COMPAT).reason, /non-functional stub/);
  assert.match(classifyImport("node:sqlite", COMPAT).reason, /non-functional stub/);
  assert.match(classifyImport("node:crypto", { compatibility_date: "2026-02-24" }).reason, /needs the nodejs_compat/);
  assert.deepEqual(classifyImport("node:crypto", { compatibility_date: "2026-09-01" }), { portable: true });
  assert.match(classifyImport("node:fs", { compatibility_date: "2025-06-01", compatibility_flags: ["nodejs_compat"] }).reason, /2025-09-01/);
  assert.deepEqual(classifyImport("node:fs", { compatibility_date: "2025-06-01", compatibility_flags: ["nodejs_compat", "enable_nodejs_fs_module"] }), { portable: true });
  assert.equal(classifyImport("agents", COMPAT), null);
  assert.equal(classifyImport("cloudflare:workers", COMPAT), null);
});

async function project(source, config = COMPAT) {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-portability-"));
  directories.push(directory);
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src/index.js"), source);
  await writeFile(join(directory, "src/helper.js"), 'import { execSync } from "child_process";\nexport const run = (command) => execSync(command).toString();\n');
  await writeFile(join(directory, "wrangler.json"), JSON.stringify({ name: "p", main: "src/index.js", kv_namespaces: [{ binding: "KV", id: "x" }], ...config }));
  return directory;
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { log: (line) => out.push(line), error: (line) => err.push(line) } };
}

test("build reports where non-portable imports come from, and --strict fails on them", async () => {
  const directory = await project('import { createHash } from "node:crypto";\nimport { run } from "./helper.js";\nimport { DurableObject } from "cloudflare:workers";\nexport default { fetch: () => new Response(createHash("sha1").update(run("ls")).digest("hex")) };\n');
  const result = await analyzeProject(await readProjectConfig(directory));
  assert.equal(result.portable, false);
  assert.deepEqual(result.findings.map(({ module, portable, importers }) => [module, portable, importers]), [
    ["node:child_process", false, ["src/helper.js"]],
    ["cloudflare:workers", true, ["src/index.js"]],
    ["node:crypto", true, ["src/index.js"]],
  ]);

  const loose = capture();
  assert.equal(await run(["build", directory], loose.io, { cwd: "/" }), 0);
  assert.match(loose.err.join("\n"), /FAIL node:child_process: node:child_process is a non-functional stub on Cloudflare Workers \(src\/helper.js\)\nok   cloudflare:workers[\s\S]*Native-only/);
  const strict = capture();
  assert.equal(await run(["build", directory, "--strict"], strict.io, { cwd: "/" }), 1);
});

test("a portable app passes --strict", async () => {
  const directory = await project('export default { fetch: async () => new Response(await crypto.subtle.digest("SHA-256", new Uint8Array([1])).then(() => "ok")) };\n');
  const output = capture();
  assert.equal(await run(["build", directory, "--strict"], output.io, { cwd: "/" }), 0);
  assert.match(output.out.join("\n"), /^Portable/m);
  assert.equal(await run(["build", directory, "--nope"], capture().io, { cwd: "/" }), 2);
});

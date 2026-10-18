import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { gzipSync } from "node:zlib";
import { CELLD_RELEASES, CELLD_VERSION, installCelld, readEngineSelection, writeEngineSelection } from "../src/engine.js";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-celld-test-"));
  directories.push(directory);
  return directory;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("downloads, verifies, unpacks, and caches a pinned celld asset", async () => {
  const dataDirectory = await temporaryDirectory();
  const binary = Buffer.from("fake executable bytes");
  const compressed = gzipSync(binary);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response(compressed, { status: 200 });
  };
  const executable = await installCelld({
    dataDirectory,
    platform: "test",
    arch: "test",
    fetchImpl,
    assets: { "test-test": { filename: "celld-test.gz", sha256: sha256(compressed) } },
  });

  assert.equal(await readFile(executable, "utf8"), binary.toString());
  assert.ok((await stat(executable)).mode & 0o111);
  assert.match(await readFile(`${executable}.sha256`, "utf8"), new RegExp(sha256(binary)));
  assert.equal(calls.length, 1);

  const cachedPath = await installCelld({
    dataDirectory,
    platform: "test",
    arch: "test",
    fetchImpl: async () => { throw new Error("cache should avoid another download"); },
    assets: { "test-test": { filename: "celld-test.gz", sha256: sha256(compressed) } },
  });
  assert.equal(cachedPath, executable);
  assert.equal(calls.length, 1);
});

test("refuses to install an asset with a bad checksum", async () => {
  const dataDirectory = await temporaryDirectory();
  const compressed = gzipSync(Buffer.from("untrusted"));
  await assert.rejects(
    installCelld({
      dataDirectory,
      platform: "test",
      arch: "test",
      fetchImpl: async () => new Response(compressed),
      assets: { "test-test": { filename: "celld-test.gz", sha256: "0".repeat(64) } },
    }),
    /checksum mismatch/,
  );
});

test("rejects platforms without a pinned release asset", async () => {
  await assert.rejects(
    installCelld({ platform: "win32", arch: "x64", fetchImpl: async () => assert.fail("must not fetch") }),
    /no release binary for win32-x64/,
  );
});

test("reports non-200 release downloads", async () => {
  const dataDirectory = await temporaryDirectory();
  await assert.rejects(
    installCelld({
      dataDirectory,
      platform: "test",
      arch: "test",
      fetchImpl: async () => new Response(null, { status: 503 }),
      assets: { "test-test": { filename: "celld-test.gz", sha256: "0".repeat(64) } },
    }),
    /HTTP 503/,
  );
});

test("pins checksums for every supported target of every known version", () => {
  assert.ok(CELLD_RELEASES[CELLD_VERSION]);
  for (const [version, assets] of Object.entries(CELLD_RELEASES)) {
    assert.deepEqual(Object.keys(assets).sort(), ["darwin-arm64", "linux-arm64", "linux-x64"], version);
    for (const asset of Object.values(assets)) assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  }
});

test("refuses versions without pinned checksums", async () => {
  await assert.rejects(
    installCelld({ version: "9.9.9", fetchImpl: async () => assert.fail("must not fetch") }),
    /not a pinned release/,
  );
});

test("round-trips the engine selection", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "sobjects-selection-"));
  try {
    assert.equal(await readEngineSelection(dataDirectory), undefined);
    await writeEngineSelection(dataDirectory, { version: "0.6.1", previous: "0.6.2" });
    assert.deepEqual(await readEngineSelection(dataDirectory), { version: "0.6.1", previous: "0.6.2" });
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

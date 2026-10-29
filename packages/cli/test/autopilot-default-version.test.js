import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { defaultPackageVersion, isBehind, parseVersion } from "../../../scripts/check-autopilot-default.mjs";

test("parseVersion reads major, minor and patch", () => {
  assert.deepEqual(parseVersion("2.8.0"), { major: 2, minor: 8, patch: 0 });
  assert.deepEqual(parseVersion(" 1.25.1 "), { major: 1, minor: 25, patch: 1 });
  assert.throws(() => parseVersion("latest"), /not a version/);
});

test("isBehind allows one minor release of lag", () => {
  assert.equal(isBehind("2.8.0", "2.8.0"), false);
  assert.equal(isBehind("2.7.1", "2.8.0"), false);
  assert.equal(isBehind("2.6.0", "2.8.0"), true);
  assert.equal(isBehind("1.25.1", "2.8.0"), true);
});

test("isBehind treats a default ahead of npm as current", () => {
  assert.equal(isBehind("2.9.0", "2.8.0"), false);
  assert.equal(isBehind("3.0.0", "2.8.0"), false);
});

test("defaultPackageVersion reads the executor's default", async () => {
  assert.equal(defaultPackageVersion('export const DEFAULT_PACKAGE = "autopilot-ai@2.8.0";'), "2.8.0");
  assert.throws(() => defaultPackageVersion("export const DEFAULT_PACKAGE = 1;"), /DEFAULT_PACKAGE/);
  const source = await readFile(new URL("../autopilot/cell-executor.js", import.meta.url), "utf8");
  assert.match(defaultPackageVersion(source), /^\d+\.\d+\.\d+$/);
});

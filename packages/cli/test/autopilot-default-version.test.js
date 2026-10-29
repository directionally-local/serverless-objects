import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { defaultPackageVersion, isBehind, isMajorBehind, parseVersion } from "../../../scripts/check-autopilot-default.mjs";

test("parseVersion reads major, minor and patch", () => {
  assert.deepEqual(parseVersion("3.0.2"), { major: 3, minor: 0, patch: 2 });
  assert.deepEqual(parseVersion(" 1.25.1 "), { major: 1, minor: 25, patch: 1 });
  assert.throws(() => parseVersion("latest"), /not a version/);
});

test("isBehind allows one minor release of lag", () => {
  assert.equal(isBehind("3.0.2", "3.0.2"), false);
  assert.equal(isBehind("2.9.1", "3.0.0"), true);
  assert.equal(isBehind("3.0.0", "3.1.0"), false);
  assert.equal(isBehind("3.0.0", "3.2.0"), true);
  assert.equal(isBehind("1.25.1", "3.0.0"), true);
});

test("isBehind treats a default ahead of npm as current", () => {
  assert.equal(isBehind("3.1.0", "3.0.2"), false);
  assert.equal(isBehind("4.0.0", "3.0.2"), false);
});

test("isMajorBehind fails only when npm has a newer major", () => {
  assert.equal(isMajorBehind("3.0.2", "3.0.2"), false);
  assert.equal(isMajorBehind("3.0.0", "3.4.0"), false);
  assert.equal(isMajorBehind("2.8.0", "3.0.2"), true);
  assert.equal(isMajorBehind("3.0.2", "4.0.0"), true);
  assert.equal(isMajorBehind("4.0.0", "3.0.2"), false);
});

test("defaultPackageVersion reads the executor's default", async () => {
  assert.equal(defaultPackageVersion('export const DEFAULT_PACKAGE = "autopilot-ai@3.0.2";'), "3.0.2");
  assert.throws(() => defaultPackageVersion("export const DEFAULT_PACKAGE = 1;"), /DEFAULT_PACKAGE/);
  const source = await readFile(new URL("../autopilot/cell-executor.js", import.meta.url), "utf8");
  assert.match(defaultPackageVersion(source), /^\d+\.\d+\.\d+$/);
});

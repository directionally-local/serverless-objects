import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/cli.js";

function invoke(argv) {
  const stdout = [];
  const stderr = [];
  const exitCode = run(argv, {
    log: (message) => stdout.push(message),
    error: (message) => stderr.push(message),
  });
  return { exitCode, stdout, stderr };
}

test("prints usage when invoked without arguments", () => {
  const result = invoke([]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout.join("\n"), /Usage: sobjects/);
  assert.deepEqual(result.stderr, []);
});

test("supports both help flags", () => {
  for (const flag of ["--help", "-h"]) {
    const result = invoke([flag]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout.join("\n"), /no engine or deployment commands/i);
  }
});

test("prints the package version", () => {
  for (const flag of ["--version", "-v", "version"]) {
    const result = invoke([flag]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stdout, ["0.1.0"]);
    assert.deepEqual(result.stderr, []);
  }
});

test("rejects commands that are not implemented", () => {
  const result = invoke(["deploy"]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr[0], /Unknown option or command: deploy/);
});

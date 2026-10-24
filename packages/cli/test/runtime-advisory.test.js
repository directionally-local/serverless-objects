import assert from "node:assert/strict";
import { test } from "node:test";
import { brotliRuntimeAdvisory } from "../src/runtime-advisory.js";

test("flags Node releases exposed to CVE-2026-111497 and passes fixed ones", () => {
  for (const version of ["20.19.5", "22.22.0", "22.23.3", "23.11.1", "24.22.0", "25.9.0", "26.12.0"]) {
    assert.match(brotliRuntimeAdvisory(version) ?? "", /CVE-2026-111497/, version);
  }
  assert.match(brotliRuntimeAdvisory("25.9.0"), /gets no fix/);
  for (const version of ["22.23.4", "22.24.0", "24.22.1", "26.12.1", "27.0.0"]) {
    assert.equal(brotliRuntimeAdvisory(version), null, version);
  }
});

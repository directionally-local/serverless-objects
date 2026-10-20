import assert from "node:assert/strict";
import { test } from "node:test";
import { REDACTED, redactDeep, redactLikelySecrets } from "../autopilot/redact.js";

test("redacts provider keys, tokens, private keys, and secret assignments", () => {
  const samples = [
    "sk-or-v1-0123456789abcdef0123456789abcdef",
    "sk-proj-abcdEFGH1234567890ijklmnopQRST",
    "ghp_0123456789abcdefABCDEF0123456789",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-123456789012-abcdefghijkl",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ];
  for (const secret of samples) assert.equal(redactLikelySecrets(`value ${secret} end`), `value ${REDACTED} end`, secret);
  assert.equal(
    redactLikelySecrets("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----"),
    REDACTED,
  );
  assert.equal(redactLikelySecrets("export DATABASE_PASSWORD='hunter2hunter2'"), `export DATABASE_PASSWORD='${REDACTED}'`);
  assert.equal(redactLikelySecrets("OPENROUTER_API_KEY=hc_gw_0123456789"), `OPENROUTER_API_KEY=${REDACTED}`);
  assert.equal(redactLikelySecrets('"apiToken": "abcd1234efgh5678"'), `"apiToken": "${REDACTED}"`);
});

test("leaves ordinary text and variable references alone", () => {
  for (const text of [
    "task-management-dashboard and ask-the-user-first",
    "TOKEN_LIMIT=5",
    "export API_KEY=$OPENROUTER_API_KEY",
    "the password field is required",
    "npm test passed: 12 passing",
  ]) assert.equal(redactLikelySecrets(text), text);
  assert.deepEqual(redactDeep({ a: ["ghp_0123456789abcdefABCDEF0123456789", 3], b: null }), { a: [REDACTED, 3], b: null });
});

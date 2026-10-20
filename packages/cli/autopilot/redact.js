// Replaces likely secrets in text bound for the session log. Ported from
// Autopilot's redactLikelySecrets (src/server/aster-tools.ts) and extended with
// a few unambiguous formats. Run-log hashes are taken before redaction.
export const REDACTED = "[REDACTED_SECRET]";

const SK_CANDIDATE_RE = /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g;
const ASSIGNMENT_RE = /\b([A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]*)(["']?\s*[:=]\s*)(["']?)([^\s"'`]{8,})\3/gi;
const PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

// "sk-" alone is common in ordinary hyphenated words; require a long chunk with a digit.
function isLikelySkKey(candidate) {
  if (/^sk-or-v1-[A-Za-z0-9]{16,}/.test(candidate)) return true;
  return candidate.slice(3).split(/[-_]/).some((chunk) => chunk.length >= 20 && /\d/.test(chunk));
}

export function redactLikelySecrets(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  let result = text.replace(SK_CANDIDATE_RE, (match) => (isLikelySkKey(match) ? REDACTED : match));
  for (const pattern of PATTERNS) result = result.replace(pattern, REDACTED);
  return result.replace(ASSIGNMENT_RE, (match, name, separator, quote, value) =>
    value === REDACTED || value.startsWith("$") ? match : `${name}${separator}${quote}${REDACTED}${quote}`);
}

// Redacts every string inside a JSON-shaped value.
export function redactDeep(value) {
  if (typeof value === "string") return redactLikelySecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)]));
  }
  return value;
}

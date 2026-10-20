// Adapts Durable Object storage to the { exec, transaction } shape RunStore uses.
export function durableObjectSql(storage) {
  return {
    exec: (query, ...bindings) => storage.sql.exec(query, ...bindings).toArray(),
    transaction: (fn) => storage.transactionSync(fn),
  };
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Tool arguments are hashed the way Autopilot's RunStore hashes them.
export function stableJson(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

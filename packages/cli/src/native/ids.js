// Durable Object IDs for the native engine: 64 hex characters, like
// Cloudflare's. The first half identifies the object (derived from the name, or
// random); the second half is a MAC over it with a per-namespace key, so
// idFromString() rejects IDs that this namespace did not issue.
import { createHash, createHmac, randomBytes } from "node:crypto";

const ID_RE = /^[0-9a-f]{64}$/;

export class DurableObjectId {
  #hex;

  constructor(hex, name) {
    this.#hex = hex;
    if (name !== undefined) this.name = name;
  }

  toString() {
    return this.#hex;
  }

  equals(other) {
    return other instanceof DurableObjectId && other.toString() === this.#hex;
  }

  toJSON() {
    return this.#hex;
  }
}

export class IdIssuer {
  #key;

  // The key is stable for a script and class, so IDs survive restarts.
  constructor(scriptName, className) {
    this.#key = createHash("sha256").update(`sobjects-native-v1\0${scriptName}\0${className}`).digest();
  }

  fromName(name) {
    if (typeof name !== "string") throw new TypeError("Durable Object names must be strings.");
    const prefix = createHmac("sha256", this.#key).update(`name\0${name}`).digest().subarray(0, 16);
    return new DurableObjectId(this.#seal(prefix), name);
  }

  unique() {
    return new DurableObjectId(this.#seal(randomBytes(16)));
  }

  fromString(hex) {
    if (typeof hex !== "string" || !ID_RE.test(hex)) throw new TypeError("Invalid Durable Object ID: expected 64 hex characters.");
    const prefix = Buffer.from(hex.slice(0, 32), "hex");
    if (this.#seal(prefix) !== hex) throw new TypeError("Invalid Durable Object ID: it was not created by this namespace.");
    return new DurableObjectId(hex);
  }

  #seal(prefix) {
    const mac = createHmac("sha256", this.#key).update(Buffer.concat([Buffer.from("id\0"), prefix])).digest().subarray(0, 16);
    return Buffer.concat([prefix, mac]).toString("hex");
  }
}

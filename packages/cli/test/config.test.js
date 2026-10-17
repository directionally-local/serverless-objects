import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { loadSobjectsConfig, parseSobjectsConfig } from "../src/config.js";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-config-test-"));
  directories.push(directory);
  return directory;
}

test("parses a minimal single-node config with the loopback default", () => {
  assert.deepEqual(parseSobjectsConfig('[celld]\nbucket = "s3://example/fleet"'), {
    bucket: "s3://example/fleet",
    listen: "127.0.0.1:8080",
  });
});

test("parses the checked-in example config", async () => {
  const example = await readFile(new URL("../../../sobjects.example.toml", import.meta.url), "utf8");
  assert.deepEqual(parseSobjectsConfig(example, "sobjects.example.toml"), {
    bucket: "s3://replace-with-your-bucket/serverless-objects",
    listen: "127.0.0.1:8080",
  });
});

test("parses optional endpoint, region, and listen address", () => {
  assert.deepEqual(
    parseSobjectsConfig(`
[celld]
bucket = "gs://example/fleet"
endpoint = "https://storage.example.test"
region = "auto"
listen = "0.0.0.0:9000"
`),
    {
      bucket: "gs://example/fleet",
      endpoint: "https://storage.example.test",
      region: "auto",
      listen: "0.0.0.0:9000",
    },
  );
});

test("rejects unknown root and engine settings", () => {
  assert.throws(
    () => parseSobjectsConfig('unknown = true\n[celld]\nbucket = "s3://example/fleet"'),
    /Unknown config key 'unknown'/,
  );
  assert.throws(
    () => parseSobjectsConfig('[celld]\nbucket = "s3://example/fleet"\nmode = "unsafe"'),
    /Unknown config key 'mode'/,
  );
});

test("requires a bucket URI for a supported object-store scheme", () => {
  assert.throws(
    () => parseSobjectsConfig('[celld]\nlisten = "127.0.0.1:8080"'),
    /bucket must be a non-empty string/,
  );
  assert.throws(
    () => parseSobjectsConfig('[celld]\nbucket = "ftp://example/fleet"'),
    /must be an s3:\/\/, gs:\/\/, or az:\/\//,
  );
});

test("validates endpoint and listener addresses", () => {
  assert.throws(
    () => parseSobjectsConfig('[celld]\nbucket = "s3://example/fleet"\nendpoint = "file:///tmp"'),
    /endpoint must use http or https/,
  );
  assert.throws(
    () => parseSobjectsConfig('[celld]\nbucket = "s3://example/fleet"\nlisten = "127.0.0.1:70000"'),
    /listen must be a host:port/,
  );
});

test("loads config from a path and reports a missing file clearly", async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, "sobjects.toml");
  await writeFile(file, '[celld]\nbucket = "az://example/fleet"\n');
  assert.equal((await loadSobjectsConfig(file)).bucket, "az://example/fleet");
  await assert.rejects(
    loadSobjectsConfig(join(directory, "missing.toml")),
    /Create an sobjects.toml/,
  );
});

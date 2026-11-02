import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/product.js";

test("product runner defaults to a local ingress and the pinned celld", () => {
  const options = parseArgs([]);
  assert.equal(options.bucket, "s3://sobjects-product");
  assert.equal(options.port, 18_443);
  assert.equal(options.timeoutMs, 60_000);
  assert.equal(options.localS3, false);
  assert.equal(options.keep, false);
  assert.equal(options.check, false);
});

test("product runner validates the bucket, port, timeout and endpoint", () => {
  assert.throws(() => parseArgs(["--bucket", "sobjects-product"]), /s3:\/\/ URI/);
  assert.throws(() => parseArgs(["--port", "0"]), /--port/);
  assert.throws(() => parseArgs(["--port", "65534"]), /--port/);
  assert.throws(() => parseArgs(["--timeout", "5"]), /--timeout/);
  assert.throws(() => parseArgs(["--endpoint", "ftp://example.com"]), /http or https/);
  assert.throws(() => parseArgs(["--endpoint", "not a url"]), /valid http\(s\) URL/);
});

test("product runner accepts a bucket endpoint and local S3", () => {
  const options = parseArgs(["--local-s3", "--endpoint", "http://127.0.0.1:18333", "--bucket", "s3://other", "--port", "19000"]);
  assert.equal(options.localS3, true);
  assert.equal(options.endpoint, "http://127.0.0.1:18333");
  assert.equal(options.bucket, "s3://other");
  assert.equal(options.port, 19_000);
});

test("check mode requires a URL", () => {
  assert.throws(() => parseArgs(["--check"]), /--check requires --url/);
  assert.equal(parseArgs(["--check", "--url", "https://localhost:18443"]).url, "https://localhost:18443");
});

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

const CELLD = '[celld]\nbucket = "s3://example/fleet"\n';

test("parses an ingress with TLS, routes, and default celld upstream", () => {
  const config = parseSobjectsConfig(`
[celld]
bucket = "s3://example/fleet"
listen = "0.0.0.0:8080"

[ingress]
listen = "0.0.0.0:443"
redirect_http = "0.0.0.0:80"
access_log = "logs/access.log"

[ingress.tls]
cert = "/etc/tls/fullchain.pem"
key = "tls/key.pem"

[[ingress.routes]]
hostname = "Agents.Example.com"

[[ingress.routes]]
hostname = "*.preview.example.com"
upstream = "http://127.0.0.1:9000/"
tls = { cert = "preview.pem", key = "preview-key.pem" }
`, "sobjects.toml", { baseDirectory: "/srv/app" });

  assert.deepEqual(config.ingress, {
    listen: "0.0.0.0:443",
    redirectHttp: "0.0.0.0:80",
    accessLog: "/srv/app/logs/access.log",
    tls: { cert: "/etc/tls/fullchain.pem", key: "/srv/app/tls/key.pem" },
    routes: [
      { hostname: "agents.example.com", upstream: "http://127.0.0.1:8080" },
      {
        hostname: "*.preview.example.com",
        upstream: "http://127.0.0.1:9000",
        tls: { cert: "/srv/app/preview.pem", key: "/srv/app/preview-key.pem" },
      },
    ],
  });
});

test("parses HTTP-01 ACME ingress and derives exact certificate names", () => {
  const config = parseSobjectsConfig(`${CELLD}[ingress]
listen = "0.0.0.0:443"
redirect_http = "0.0.0.0:80"

[ingress.acme]
email = "ops@example.com"
agree_to_terms = true

[[ingress.routes]]
hostname = "agents.example.com"

[[ingress.routes]]
hostname = "static.example.com"
tls = { cert = "static.pem", key = "static-key.pem" }
`, "sobjects.toml", { baseDirectory: "/srv/app" });
  assert.deepEqual(config.ingress.acme, {
    email: "ops@example.com",
    agreeToTerms: true,
    directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
    domains: ["agents.example.com"],
  });
  assert.equal(config.ingress.redirectHttp, "0.0.0.0:80");
  assert.equal(config.ingress.routes[1].tls.cert, "/srv/app/static.pem");
});

test("validates ACME consent, HTTP-01 listener, directory transport, and hostname limits", () => {
  const makeConfig = (ingress) => `${CELLD}${ingress}`;
  const prefix = '[ingress]\nlisten = "0.0.0.0:443"\nredirect_http = "0.0.0.0:80"\n';
  const noRedirect = '[ingress]\nlisten = "0.0.0.0:443"\n';
  const acme = '[ingress.acme]\nemail = "ops@example.com"\nagree_to_terms = true\n';
  const route = '[[ingress.routes]]\nhostname = "agents.example.com"\n';
  assert.throws(
    () => parseSobjectsConfig(makeConfig(`${prefix}[ingress.acme]\nemail = "ops@example.com"\n${route}`)),
    /agree_to_terms must be true/,
  );
  assert.throws(
    () => parseSobjectsConfig(makeConfig(`${noRedirect}${acme}${route}`)),
    /requires redirect_http on port 80/,
  );
  assert.throws(
    () => parseSobjectsConfig(makeConfig(`${prefix.replace('0.0.0.0:80', '0.0.0.0:8080')}${acme}${route}`)),
    /redirect_http to listen on port 80/,
  );
  assert.throws(
    () => parseSobjectsConfig(makeConfig(`${prefix}${acme.replace('agree_to_terms = true', 'agree_to_terms = false')}${route}`)),
    /agree_to_terms must be true/,
  );
  const insecureDirectory = '[ingress.acme]\nemail = "ops@example.com"\nagree_to_terms = true\ndirectory_url = "http://acme.example.test/directory"\n';
  assert.throws(
    () => parseSobjectsConfig(makeConfig(`${prefix}${insecureDirectory}${route}`)),
    /directory_url must use HTTPS/,
  );
  assert.throws(
    () => parseSobjectsConfig(makeConfig(`${prefix}${acme}${route.replace('agents.example.com', '*.example.com')}`)),
    /cannot issue HTTP-01 certificates for wildcard/,
  );
});

test("allows plaintext ingress only on loopback", () => {
  const plain = parseSobjectsConfig(
    `${CELLD}[ingress]\nlisten = "127.0.0.1:8443"\n[[ingress.routes]]\nhostname = "*"\n`,
  );
  assert.equal(plain.ingress.tls, undefined);
  assert.equal(plain.ingress.routes[0].upstream, "http://127.0.0.1:8080");

  assert.throws(
    () => parseSobjectsConfig(`${CELLD}[ingress]\nlisten = "0.0.0.0:80"\n[[ingress.routes]]\nhostname = "*"\n`),
    /not loopback; add \[ingress.tls\]/,
  );
  assert.throws(
    () => parseSobjectsConfig(
      `${CELLD}[ingress]\nlisten = "127.0.0.1:8443"\nredirect_http = "127.0.0.1:8081"\n[[ingress.routes]]\nhostname = "*"\n`,
    ),
    /redirect_http requires \[ingress.tls\]/,
  );
});

test("rejects invalid ingress settings", () => {
  const withIngress = (body) => `${CELLD}[ingress]\nlisten = "127.0.0.1:8443"\n${body}`;
  assert.throws(() => parseSobjectsConfig(withIngress("")), /at least one \[\[ingress.routes\]\]/);
  assert.throws(
    () => parseSobjectsConfig(withIngress('[[ingress.routes]]\nhostname = "bad host"\n')),
    /hostname must be a hostname/,
  );
  assert.throws(
    () => parseSobjectsConfig(withIngress('[[ingress.routes]]\nhostname = "a.test"\n[[ingress.routes]]\nhostname = "A.test"\n')),
    /listed more than once/,
  );
  assert.throws(
    () => parseSobjectsConfig(withIngress('[[ingress.routes]]\nhostname = "a.test"\nupstream = "https://x"\n')),
    /http:\/\/ origin/,
  );
  assert.throws(
    () => parseSobjectsConfig(withIngress('[[ingress.routes]]\nhostname = "a.test"\ntls = { cert = "c", key = "k" }\n')),
    /requires a default \[ingress.tls\]/,
  );
  assert.throws(
    () => parseSobjectsConfig(withIngress('mode = "x"\n[[ingress.routes]]\nhostname = "a.test"\n')),
    /Unknown config key 'mode'/,
  );
  assert.throws(
    () => parseSobjectsConfig(`${CELLD}[ingress]\nlisten = "127.0.0.1:8080"\n[[ingress.routes]]\nhostname = "*"\n`),
    /must differ from \[celld\].listen/,
  );
});

test("parses [admin] and derives celld's operator listener", () => {
  const config = parseSobjectsConfig(`${CELLD}[admin]\nlisten = "127.0.0.1:8790"\n`);
  assert.deepEqual(config.admin, { listen: "127.0.0.1:8790" });
  assert.equal(config.internalListen, "127.0.0.1:8081");

  const explicit = parseSobjectsConfig(
    '[celld]\nbucket = "s3://example/fleet"\ninternal_listen = "127.0.0.1:9100"\n[admin]\nlisten = "127.0.0.1:8790"\n',
  );
  assert.equal(explicit.internalListen, "127.0.0.1:9100");
  assert.equal(parseSobjectsConfig(CELLD).internalListen, undefined);
});

test("keeps the admin API and operator listener on loopback", () => {
  assert.throws(
    () => parseSobjectsConfig(`${CELLD}[admin]\nlisten = "0.0.0.0:8790"\n`),
    /\[admin\].listen must be a loopback address/,
  );
  assert.throws(
    () => parseSobjectsConfig('[celld]\nbucket = "s3://example/fleet"\ninternal_listen = "10.0.0.2:8081"\n'),
    /internal_listen must be loopback/,
  );
  assert.throws(
    () => parseSobjectsConfig('[celld]\nbucket = "s3://example/fleet"\ninternal_listen = "127.0.0.1:8080"\n'),
    /must not reuse another listener/,
  );
  assert.throws(
    () => parseSobjectsConfig(`${CELLD}[admin]\nlisten = "127.0.0.1:8790"\ntoken = "x"\n`),
    /Unknown config key 'token'/,
  );
});

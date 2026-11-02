import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runAgentsClientCheck, runAgentsScheduleCheck, runCases } from "./run.js";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_APP = path.join(PACKAGE_DIR, "agents-app");
const SOBJECTS_BIN = path.resolve(PACKAGE_DIR, "..", "cli", "bin", "sobjects.mjs");
const DEFAULT_CELLD_BIN = path.join(os.homedir(), ".local/share/serverless-objects/engines/celld-0.6.2/celld");
const LOCAL_S3_IMAGE = "chrislusf/seaweedfs:4.48";
const LOCAL_S3_ACCESS_KEY = "sobjects";
const LOCAL_S3_SECRET_KEY = "sobjects-secret";

export function parseArgs(args) {
  const options = {
    bucket: "s3://sobjects-product",
    endpoint: undefined,
    region: "us-east-1",
    port: 18_443,
    timeoutMs: 60_000,
    celldBin: process.env.CELLD_BIN ?? DEFAULT_CELLD_BIN,
    localS3: false,
    keep: false,
    check: false,
    url: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--bucket") options.bucket = args[++index];
    else if (arg === "--endpoint") options.endpoint = args[++index];
    else if (arg === "--region") options.region = args[++index];
    else if (arg === "--port") options.port = Number(args[++index]);
    else if (arg === "--timeout") options.timeoutMs = Number(args[++index]);
    else if (arg === "--celld-bin") options.celldBin = args[++index];
    else if (arg === "--local-s3") options.localS3 = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--url") options.url = args[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (options.help) return options;
  if (!/^s3:\/\/[^/\s]+(?:\/[^\s]*)?$/.test(options.bucket)) throw new Error("--bucket must be an s3:// URI with a bucket name");
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_532) throw new Error("--port must be an integer from 1 to 65532");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) throw new Error("--timeout must be at least 1000 milliseconds");
  if (options.check && !options.url) throw new Error("--check requires --url");
  if (options.endpoint !== undefined) {
    let url;
    try {
      url = new URL(options.endpoint);
    } catch {
      throw new Error("--endpoint must be a valid http(s) URL");
    }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("--endpoint must use http or https");
  }
  return options;
}

function usage() {
  return [
    "Usage: node src/product.js [options]",
    "",
    "Deploys the Agents app with 'sobjects deploy' and serves it with",
    "'sobjects up' behind TLS ingress, then runs the Agents SDK checks against",
    "that deployment. Needs a bucket and celld; --local-s3 starts SeaweedFS.",
    "",
    "Options:",
    "  --bucket URI          Bucket to deploy to (default: s3://sobjects-product)",
    "  --endpoint URL        S3-compatible endpoint (default: --local-s3's SeaweedFS)",
    "  --region REGION       Bucket region (default: us-east-1)",
    "  --port PORT           Ingress port (default: 18443; celld, operator and admin use +1 to +3)",
    "  --timeout MS          Startup timeout (default: 60000)",
    "  --celld-bin PATH      celld executable (or set CELLD_BIN)",
    "  --local-s3            Start a disposable SeaweedFS container and create the bucket",
    "  --keep                Leave the node, bucket and scratch directory running",
    "  --check --url URL     Internal: run the checks against URL and print JSON",
  ].join("\n");
}

function run(command, args, { env = process.env, cwd = PACKAGE_DIR, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    if (capture) {
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${path.basename(command)} ${args.join(" ")} exited ${code}${output ? `:\n${output}` : ""}`));
    });
  });
}

function sobjects(args, env) {
  return run(process.execPath, [SOBJECTS_BIN, ...args], { env: { ...process.env, ...env } });
}

async function startLocalS3(options) {
  const name = `sobjects-product-s3-${process.pid}`;
  const bucket = options.bucket.replace(/^s3:\/\//, "").split("/")[0];
  const script = [
    'printf \'{"identities":[{"name":"sobjects","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","Write","List","Tagging"]}]}\'',
    '"$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" > /tmp/s3.json',
    "&& exec weed server -dir=/data -s3 -s3.config=/tmp/s3.json",
  ].join(" ");
  await run("docker", [
    "run", "-d", "--name", name, "--entrypoint", "/bin/sh",
    "-p", "127.0.0.1:18333:8333", "-p", "127.0.0.1:19333:9333",
    "-e", `AWS_ACCESS_KEY_ID=${LOCAL_S3_ACCESS_KEY}`,
    "-e", `AWS_SECRET_ACCESS_KEY=${LOCAL_S3_SECRET_KEY}`,
    LOCAL_S3_IMAGE, "-c", script,
  ], { capture: true });

  const endpoint = "http://127.0.0.1:18333";
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    try {
      // SeaweedFS answers an unauthenticated request with 403 once S3 is up.
      await fetch(endpoint, { signal: AbortSignal.timeout(1_000) });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await run("docker", ["exec", name, "sh", "-c", `echo "s3.bucket.create -name ${bucket}" | weed shell -master=127.0.0.1:9333`], { capture: true });
  return { name, endpoint };
}

async function generateCertificate(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cert = path.join(directory, "fullchain.pem");
  const key = path.join(directory, "privkey.pem");
  await run("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "30",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    "-keyout", key, "-out", cert,
  ], { capture: true });
  return { cert, key };
}

function configSource({ bucket, endpoint, region, port, cert, key }) {
  const lines = [
    "[celld]",
    `bucket = "${bucket}"`,
  ];
  if (endpoint) lines.push(`endpoint = "${endpoint}"`);
  if (region) lines.push(`region = "${region}"`);
  lines.push(
    `listen = "127.0.0.1:${port + 1}"`,
    `internal_listen = "127.0.0.1:${port + 2}"`,
    "",
    "[ingress]",
    `listen = "127.0.0.1:${port}"`,
    'access_log = "-"',
    "",
    "[ingress.tls]",
    `cert = "${cert}"`,
    `key = "${key}"`,
    "",
    "[[ingress.routes]]",
    'hostname = "localhost"',
    "",
    "[admin]",
    `listen = "127.0.0.1:${port + 3}"`,
    "",
  );
  return lines.join("\n");
}

async function waitForIngress(baseUrl, cert, timeoutMs) {
  const url = new URL("/.well-known/sobjects/health", baseUrl);
  const ca = readFileSync(cert);
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const status = await new Promise((resolve, reject) => {
        const request = httpsRequest({
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          ca,
          servername: url.hostname,
          timeout: 2_000,
        }, (response) => {
          response.resume();
          resolve(response.statusCode);
        });
        request.on("timeout", () => request.destroy(new Error("health request timed out")));
        request.on("error", reject);
        request.end();
      });
      if (status === 200) return;
      lastError = new Error(`health returned HTTP ${status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Ingress did not become healthy within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ""}`);
}

// The checks run in a child process so NODE_EXTRA_CA_CERTS trusts the
// self-signed certificate from the moment Node starts.
async function runChecks(baseUrl, cert) {
  const output = await run(process.execPath, [fileURLToPath(import.meta.url), "--check", "--url", baseUrl], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
    capture: true,
  });
  const line = output.trim().split("\n").at(-1);
  return JSON.parse(line);
}

async function check(baseUrl) {
  const results = await runCases(baseUrl);
  const record = async (name, fn) => {
    try {
      results.push({ name, ...await fn() });
    } catch (error) {
      results.push({ name, pass: false, detail: String(error?.message ?? error) });
    }
  };
  await record("client-protocol", () => runAgentsClientCheck(baseUrl));
  await record("schedule-fires", () => runAgentsScheduleCheck(baseUrl));
  return results;
}

async function main(args) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.check) {
    const results = await check(options.url);
    console.log(JSON.stringify(results));
    if (results.some((result) => !result.pass)) process.exitCode = 1;
    return;
  }

  await mkdir(path.join(PACKAGE_DIR, ".runs"), { recursive: true });
  const scratchDir = await mkdtemp(path.join(PACKAGE_DIR, ".runs", "product-"));
  const stateDirectory = path.join(scratchDir, "state");
  const projectDir = path.join(scratchDir, "agents");
  let localS3;
  let started = false;
  const env = {
    SOBJECTS_STATE_DIR: stateDirectory,
    AWS_REGION: options.region,
  };
  if (options.celldBin) env.SOBJECTS_CELLD_BIN = options.celldBin;

  try {
    if (options.localS3) {
      localS3 = await startLocalS3(options);
      options.endpoint ??= localS3.endpoint;
      env.AWS_ACCESS_KEY_ID ??= process.env.AWS_ACCESS_KEY_ID ?? LOCAL_S3_ACCESS_KEY;
      env.AWS_SECRET_ACCESS_KEY ??= process.env.AWS_SECRET_ACCESS_KEY ?? LOCAL_S3_SECRET_KEY;
    }
    await cp(AGENTS_APP, projectDir, { recursive: true });
    const { cert, key } = await generateCertificate(path.join(projectDir, "tls"));
    await writeFile(path.join(projectDir, "sobjects.toml"), configSource({ ...options, cert, key }));

    console.log(`Deploying ${projectDir} to ${options.bucket}`);
    await sobjects(["deploy", projectDir], env);

    console.log("Starting the node with sobjects up --detach");
    await sobjects(["up", "--config", path.join(projectDir, "sobjects.toml"), "--detach"], env);
    started = true;

    const baseUrl = `https://localhost:${options.port}`;
    await waitForIngress(baseUrl, cert, options.timeoutMs);
    const results = await runChecks(baseUrl, cert);

    console.log("\nProduct-path results — sobjects deploy + sobjects up");
    for (const result of results) console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
    const failed = results.filter((result) => !result.pass);
    console.log(`${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) process.exitCode = 1;
  } finally {
    if (started && !options.keep) await sobjects(["down"], env).catch((error) => console.error(`Could not stop the node: ${error.message}`));
    if (localS3 && !options.keep) await run("docker", ["rm", "-f", localS3.name], { capture: true }).catch(() => {});
    if (options.keep) console.log(`Kept ${scratchDir}${localS3 ? ` and container ${localS3.name}` : ""}.`);
    else await rm(scratchDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}

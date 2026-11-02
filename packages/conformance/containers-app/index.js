// Containers conformance app: one Durable Object class with a container, and
// routes that exercise the parts of the Cloudflare Containers contract that
// celld 0.6.2 implements. The same bundle runs on celld; the runner drives the
// multi-step checks (sleep, restart) over HTTP.
import { DurableObject } from "cloudflare:workers";
import { DirectoryBackup, S3Mount } from "@cloudflare/sandbox";

// The sandbox package reaches its gateways through ctx.exports, so the main
// module must re-export them.
export { DirectoryBackupGateway, S3Gateway } from "@cloudflare/sandbox";

const PORT = 8080;
const MARKER = "/tmp/conformance-marker";

const text = (value) => {
  if (value == null) return "";
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  return new TextDecoder().decode(value);
};

async function exec(container, command) {
  const process = await container.exec(["sh", "-c", command]);
  const output = await process.output();
  return { stdout: text(output.stdout), stderr: text(output.stderr), exitCode: output.exitCode };
}

// start() returns before the container exists, so exec() is the readiness
// probe: it fails with "No such container" until the engine has created it.
async function waitForExec(container, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      await exec(container, "true");
      return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`container did not accept exec within ${timeoutMs}ms: ${last?.message ?? last}`);
}

async function waitForHttp(container, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await container.getTcpPort(PORT).fetch(`http://container/ready`);
      if (response.ok) return JSON.parse(await response.text());
      last = new Error(`HTTP ${response.status}`);
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`container did not answer on port ${PORT} within ${timeoutMs}ms: ${last?.message ?? last}`);
}

export class Box extends DurableObject {
  // A new value means the runtime constructed a new instance, e.g. after idle
  // eviction or a process restart.
  instance = crypto.randomUUID();

  async start({ enableInternet = true, marker = this.instance } = {}) {
    const container = this.ctx.container;
    if (!container.running) {
      container.start({ enableInternet, env: { MESSAGE: "conformance" } });
    }
    await waitForExec(container);
    const ready = await waitForHttp(container);
    await exec(container, `printf '%s' '${marker}' > ${MARKER}`);
    return { instance: this.instance, hostname: ready.hostname, running: container.running };
  }

  async state() {
    const container = this.ctx.container;
    let marker = null;
    let hostname = null;
    if (container.running) {
      try {
        marker = (await exec(container, `cat ${MARKER} 2>/dev/null || true`)).stdout;
      } catch {
        // The container is running but exec is not available yet.
      }
      try {
        hostname = (await waitForHttp(container, 5_000)).hostname;
      } catch {
        // The server is not answering; the container may still be starting.
      }
    }
    return { instance: this.instance, running: container.running, marker, hostname };
  }

  async execCheck() {
    const container = this.ctx.container;
    await waitForExec(container);
    const uname = await exec(container, "uname -s");
    const marker = await exec(container, `cat ${MARKER} 2>/dev/null || true`);
    return { uname: uname.stdout.trim(), marker: marker.stdout, exitCode: uname.exitCode };
  }

  async httpCheck() {
    const container = this.ctx.container;
    return { ready: await waitForHttp(container) };
  }

  async egress() {
    const container = this.ctx.container;
    await waitForExec(container);
    const result = await exec(
      container,
      "python3 -c \"import socket; socket.create_connection(('1.1.1.1', 443), 5); print('connected')\"",
    );
    return { connected: result.exitCode === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  }

  // The parts of the Containers API that celld 0.6.2 documents as rejected.
  async unsupported() {
    const container = this.ctx.container;
    await waitForExec(container);
    const attempt = async (operation) => {
      try {
        await operation();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    };
    return {
      images: container.images === undefined ? null : Object.keys(container.images),
      interceptOutboundHttp: await attempt(() => container.interceptOutboundHttp("example.com", this.ctx.exports.S3Gateway({ props: {} }))),
      interceptAllOutboundHttp: await attempt(() => container.interceptAllOutboundHttp(this.ctx.exports.S3Gateway({ props: {} }))),
      inspect: await attempt(() => container.inspect()),
      snapshotDirectory: await attempt(() => container.snapshotDirectory("/tmp")),
      snapshotContainer: await attempt(() => container.snapshotContainer()),
    };
  }

  // S3Mount needs interceptOutboundHttp and a sandbox-shim image. The image
  // here has the shim, so the failure names the missing runtime method.
  async s3mount() {
    const container = this.ctx.container;
    await waitForExec(container);
    const mounts = new S3Mount(container, this.ctx.exports.S3Gateway);
    try {
      await mounts.mount({
        mountPath: "/mnt/conformance",
        source: {
          type: "s3",
          endpoint: "http://127.0.0.1:9000",
          region: "us-east-1",
          bucket: "conformance",
          credentials: { type: "static", accessKeyId: "conformance", secretAccessKey: "conformance" },
        },
        access: "read-only",
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), code: error?.code ?? null };
    }
  }

  // DirectoryBackup needs interceptOutboundHttp and an R2 binding. intercept()
  // reaches the runtime method without touching R2.
  async directoryBackup() {
    const container = this.ctx.container;
    await waitForExec(container);
    const backups = new DirectoryBackup(container, this.ctx.exports.DirectoryBackupGateway, {
      binding: "BACKUPS",
      prefix: "conformance/",
    });
    const attempt = async (operation) => {
      try {
        await operation();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error), code: error?.code ?? null };
      }
    };
    return {
      intercept: await attempt(() => backups.intercept()),
      backup: await attempt(() => backups.backup({ dir: "/tmp" })),
    };
  }

  // Cloudflare's exec() waits for a container that is still starting. celld's
  // start() is fire-and-forget and exec() rejects until the engine has created
  // the container, so this records the divergence rather than hiding it.
  async execAfterStart() {
    const container = this.ctx.container;
    if (container.running) await container.destroy();
    container.start({ enableInternet: true });
    try {
      await exec(container, "true");
      return { raced: false };
    } catch (error) {
      return { raced: true, error: String(error?.message ?? error) };
    }
  }

  async destroyContainer() {
    if (this.ctx.container.running) await this.ctx.container.destroy();
  }
}

const CASES = {
  async "exec-after-start"(box) {
    const result = await box.execAfterStart();
    if (!result.raced) throw new Error("exec() succeeded immediately after start(); the celld race was not observed");
    return `exec() immediately after start() failed as celld 0.6.2 documents: ${result.error}`;
  },
  async "start-exec-http"(box) {
    const started = await box.start({ marker: "start-exec-http" });
    const exec = await box.execCheck();
    const http = await box.httpCheck();
    if (exec.uname !== "Linux") throw new Error(`uname: ${JSON.stringify(exec)}`);
    if (exec.marker !== "start-exec-http") throw new Error(`marker: ${JSON.stringify(exec)}`);
    if (http.ready.hostname !== started.hostname) throw new Error(`hostname: ${JSON.stringify({ started, http })}`);
    return `start(), exec() (${exec.uname}), and getTcpPort().fetch() (${http.ready.hostname})`;
  },
  async egress(box, env) {
    const online = env.BOX.get(env.BOX.idFromName("egress-online"));
    const offline = env.BOX.get(env.BOX.idFromName("egress-offline"));
    await online.start({ enableInternet: true, marker: "online" });
    await offline.start({ enableInternet: false, marker: "offline" });
    const onlineResult = await online.egress();
    const offlineResult = await offline.egress();
    if (!onlineResult.connected) throw new Error(`enableInternet: true did not reach the Internet: ${JSON.stringify(onlineResult)}`);
    if (offlineResult.connected) throw new Error(`enableInternet: false still reached the Internet: ${JSON.stringify(offlineResult)}`);
    return `enableInternet: true connected; enableInternet: false was refused (${offlineResult.stderr || offlineResult.stdout})`;
  },
  async unsupported(box) {
    const result = await box.unsupported();
    const rejected = ["interceptOutboundHttp", "interceptAllOutboundHttp", "inspect", "snapshotDirectory", "snapshotContainer"];
    for (const name of rejected) {
      if (result[name].ok) throw new Error(`${name} unexpectedly succeeded`);
      if (!/not implemented in celld/.test(result[name].error)) throw new Error(`${name}: ${result[name].error}`);
    }
    if (result.images !== null) throw new Error(`container.images is defined: ${JSON.stringify(result.images)}`);
    return "interceptOutboundHttp, interceptAllOutboundHttp, inspect, snapshotDirectory and snapshotContainer reject; container.images is undefined";
  },
  async s3mount(box) {
    const result = await box.s3mount();
    if (result.ok) throw new Error("S3Mount.mount() unexpectedly succeeded");
    return `S3Mount.mount() failed: ${result.error}`;
  },
  async "directory-backup"(box) {
    const result = await box.directoryBackup();
    if (result.intercept.ok) throw new Error("DirectoryBackup.intercept() unexpectedly succeeded");
    if (result.backup.ok) throw new Error("DirectoryBackup.backup() unexpectedly succeeded");
    return `DirectoryBackup.intercept() failed: ${result.intercept.error}; backup() failed: ${result.backup.error}`;
  },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "default";
    const box = env.BOX.get(env.BOX.idFromName(name));

    if (url.pathname === "/cases") return Response.json(Object.keys(CASES));
    if (url.pathname === "/container/start") {
      const enableInternet = url.searchParams.get("internet") !== "false";
      const marker = url.searchParams.get("marker") ?? undefined;
      return Response.json(await box.start({ enableInternet, marker }));
    }
    if (url.pathname === "/container/state") return Response.json(await box.state());
    if (url.pathname === "/container/destroy") {
      await box.destroyContainer();
      return Response.json({ ok: true });
    }

    const caseName = url.pathname.replace(/^\/case\//, "");
    if (url.pathname.startsWith("/case/") && CASES[caseName]) {
      try {
        return Response.json({ pass: true, detail: await CASES[caseName](box, env) });
      } catch (error) {
        return Response.json({ pass: false, detail: String(error?.message ?? error) });
      }
    }
    return new Response("ok");
  },
};

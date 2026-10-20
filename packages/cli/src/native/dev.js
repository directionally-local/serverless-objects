// `sobjects dev --engine native`: run a project on the native engine.
import { resolve } from "node:path";

export const nativeDevHelp = `Usage: sobjects dev [project] --engine native [--port PORT] [--host HOST] [--persist-to DIR]

Run a Wrangler project's Worker and Durable Objects in this Node process, with
each object's storage in a SQLite file under --persist-to (default:
<project>/.sobjects/native). For trusted code: there is no isolate between the
app and the engine. Supported: Durable Objects (IDs, RPC, fetch, KV and SQL
storage, transactions, alarms, input gates) and vars.`;

export function wantsNativeEngine(args) {
  return args.some((argument, index) => argument === "--engine=native" || (argument === "--engine" && args[index + 1] === "native"));
}

export function parseNativeDevArgs(args, cwd) {
  const options = { project: ".", port: 8787, host: "127.0.0.1", persistTo: undefined };
  let sawProject = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = () => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`Option ${argument} requires a value.`);
      index += 1;
      return next;
    };
    if (argument === "--engine") value();
    else if (argument === "--engine=native") continue;
    else if (argument === "--port") options.port = Number(value());
    else if (argument === "--host" || argument === "--ip") options.host = value();
    else if (argument === "--persist-to") options.persistTo = value();
    else if (!argument.startsWith("-") && !sawProject) {
      options.project = argument;
      sawProject = true;
    } else throw new Error(`Unknown option for the native engine: ${argument}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) throw new Error("--port must be an integer from 0 to 65535.");
  const project = resolve(cwd, options.project);
  return { ...options, project, persistTo: resolve(cwd, options.persistTo ?? resolve(project, ".sobjects", "native")) };
}

export async function runNativeDev(args, io, { cwd, onSignal }) {
  if (args.includes("--help") || args.includes("-h")) {
    io.log(nativeDevHelp);
    return 0;
  }
  let options;
  let engine;
  try {
    options = parseNativeDevArgs(args, cwd);
    // Loaded on demand: node:sqlite prints an experimental warning when imported.
    const { NativeEngine, loadProjectConfig } = await import("./engine.js");
    const config = await loadProjectConfig(options.project);
    engine = new NativeEngine({ config, persistDirectory: options.persistTo, log: (message) => io.error(message) });
    await engine.start();
    const address = await engine.listen({ host: options.host, port: options.port });
    io.log(`Native engine ready on http://${address.address}:${address.port} (state: ${options.persistTo})`);
  } catch (error) {
    io.error(error.message);
    await engine?.close().catch(() => {});
    return 1;
  }
  return new Promise((resolveExit) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await engine.close();
      resolveExit(0);
    };
    onSignal("SIGINT", stop);
    onSignal("SIGTERM", stop);
  });
}

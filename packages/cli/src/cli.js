import { spawn } from "node:child_process";
import { createWriteStream, readFileSync, statSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadSobjectsConfig } from "./config.js";
import {
  CELLD_RELEASES,
  CELLD_VERSION,
  defaultDataDirectory,
  installCelld,
  isCelldInstalled,
  readEngineSelection,
  writeEngineSelection,
} from "./engine.js";
import { createIngressMetrics, startAdmin } from "./admin.js";
import { createCelldAdapter } from "./celld-adapter.js";
import { HEALTH_PATH, startIngress } from "./ingress.js";
import { ensureInspectorToken, readInspectorToken, tokenHash } from "./inspector.js";
import { renderLaunchdPlist, renderSystemdUnit, unitTarget, writeUnit } from "./units.js";
import { prepareWranglerProject } from "./wrangler.js";
import {
  defaultStateDirectory,
  getServiceStatus as getDetachedStatus,
  readServiceLogs as readDetachedLogs,
  startDetached,
  stopService as stopDetached,
} from "./service.js";

const CLI_SCRIPT = fileURLToPath(new URL("../bin/sobjects.mjs", import.meta.url));
const BUNDLED_ESBUILD_BIN = bundledEsbuildDirectory();

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const helpText = `Serverless Objects — self-hostable Workers infrastructure for agents

Usage: sobjects <command> [options]

Commands:
  up [--config PATH] [--detach]  Start celld plus the configured ingress and admin API
  down                           Stop a detached node and its supervisor
  status                         Show detached process status
  logs [--supervisor] [--tail N] Show recent detached celld or supervisor logs
  supervise [--config PATH]      Run only the ingress and admin API in the foreground
  service print|install [opts]   Generate a systemd or launchd unit for up
  upgrade [--rollback|--status]  Install and select a pinned celld version
  dev [project] [options]        Run a project locally with celld
  deploy [project] [options]     Deploy a project with celld

Options:
  -h, --help      Show this help
  -v, --version   Show the installed version

The CLI installs the pinned celld v${CELLD_VERSION} release on first use. Set
SOBJECTS_CELLD_BIN to use an existing binary instead.`;

const upHelpText = `Usage: sobjects up [--config PATH] [--detach]

Read [celld] settings from sobjects.toml, install pinned celld if needed, and
run the node in the foreground by default. When [ingress] or [admin] is
configured, the supervisor (TLS ingress and loopback admin API) starts first.
Use --detach to run them in the background. The default config path is ./sobjects.toml.`;

const serviceHelpText = `Usage: sobjects service print|install [options]

Generate a service unit that runs 'sobjects up' in the foreground.

Options:
  --config PATH      sobjects.toml to run (default: ./sobjects.toml)
  --kind KIND        systemd or launchd (default: launchd on macOS, else systemd)
  --system           systemd only: system unit with CAP_NET_BIND_SERVICE
  --user NAME        account for a --system unit
  --force            install: replace an existing unit file

'install' writes the unit and prints the commands that enable it; it does not
start the service. Put object-store credentials in sobjects.env beside the
config (systemd) or in the unit's environment, never in sobjects.toml.`;

const superviseHelpText = `Usage: sobjects supervise [--config PATH]

Run the [ingress] and [admin] services from sobjects.toml in the foreground,
next to a celld started separately. SIGHUP reloads TLS certificates from disk.
Ingress health: ${HEALTH_PATH}. Admin API: /api/v1/health, /api/v1/node,
/api/v1/objects, POST /api/v1/objects/<Class:id>/evict, and /metrics.`;

export async function run(
  argv = process.argv.slice(2),
  io = console,
  {
    spawnProcess = spawn,
    env = process.env,
    cwd = process.cwd(),
    installEngine = installCelld,
    loadConfig = loadSobjectsConfig,
    prepareProject = prepareWranglerProject,
    startService = startDetached,
    getServiceStatus = getDetachedStatus,
    readServiceLogs = readDetachedLogs,
    stopService = stopDetached,
    startIngressServer = startIngress,
    startAdminServer = startAdmin,
    createEngine = createCelldAdapter,
    onSignal = subscribeToSignal,
    nodeExecutable = process.execPath,
    readSelection = readEngineSelection,
    ensureToken = ensureInspectorToken,
    readToken = readInspectorToken,
    writeSelection = writeEngineSelection,
    isInstalled = isCelldInstalled,
    ...dependencies
  } = {},
) {
  if (argv.length === 0 || (argv.length === 1 && ["--help", "-h"].includes(argv[0]))) {
    io.log(helpText);
    return 0;
  }

  if (argv.length === 1 && ["--version", "-v", "version"].includes(argv[0])) {
    io.log(version);
    return 0;
  }

  const [command, ...args] = argv;
  if (command === "up") {
    return runUp(args, io, {
      spawnProcess,
      env,
      cwd,
      installEngine,
      loadConfig,
      startService,
      stopService,
      startIngressServer,
      onSignal,
      nodeExecutable,
      readSelection,
      startAdminServer,
      createEngine,
      readToken,
    });
  }
  if (command === "supervise") {
    return runSupervise(args, io, {
      env,
      cwd,
      loadConfig,
      startIngressServer,
      startAdminServer,
      createEngine,
      onSignal,
      installEngine,
      readSelection,
      readToken,
    });
  }
  if (command === "upgrade") {
    return runUpgrade(args, io, { env, installEngine, readSelection, writeSelection, isInstalled, getServiceStatus });
  }
  if (command === "service") {
    return runService(args, io, { env, cwd, loadConfig, nodeExecutable, platform: dependencies.platform });
  }
  if (command === "down") return runDown(args, io, { env, stopService });
  if (command === "status") return runStatus(args, io, { env, getServiceStatus });
  if (command === "logs") return runLogs(args, io, { env, readServiceLogs });
  if (command === "dev" || command === "deploy") {
    return runCelld(command, args, io, { spawnProcess, env, cwd, installEngine, prepareProject, loadConfig, readSelection, ensureToken });
  }

  io.error(`Unknown option or command: ${command}`);
  io.error("Run 'sobjects --help' to see the available commands.");
  return 2;
}

async function runUp(args, io, dependencies) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    io.log(upHelpText);
    return 0;
  }

  const options = parseConfigOptions(args, io, "up", { allowDetach: true });
  if (!options) return 2;
  const { configPath, detached } = options;

  let config;
  try {
    config = await dependencies.loadConfig(resolve(dependencies.cwd, configPath));
  } catch (error) {
    io.error(error.message);
    return 2;
  }

  let executable;
  try {
    executable = await resolveCelld(dependencies);
  } catch (error) {
    io.error(error.message);
    return 1;
  }

  const storageArgs = celldStorageArgs(config);
  const argsForCelld = [...storageArgs, "--listen", config.listen];
  if (config.internalListen) argsForCelld.push("--internal-listen", config.internalListen);
  if (config.ingress) {
    // The ingress replaces X-Forwarded-Host/Proto, so celld can use them for
    // request.url. Only trust them when nothing but local processes, such as
    // the ingress, can reach celld; otherwise clients could spoof them.
    if (isLoopbackAddress(config.listen)) {
      argsForCelld.push("--trust-forwarded-headers");
    } else {
      io.error(
        `Warning: [celld].listen ${config.listen} is not loopback, so celld will not trust the ingress's forwarded headers and request.url keeps celld's own scheme and host.`,
      );
    }
  }
  const stateDirectory = defaultStateDirectory(dependencies.env);
  const needsSupervisor = Boolean(config.ingress || config.admin);
  if (detached) {
    let state;
    try {
      state = await dependencies.startService({
        executable,
        args: argsForCelld,
        env: dependencies.env,
        cwd: dependencies.cwd,
        stateDirectory,
        spawnProcess: dependencies.spawnProcess,
      });
    } catch (error) {
      io.error(error.message);
      return 1;
    }
    io.log(`Started celld in the background (pid ${state.pid}).`);
    io.log(`Log file: ${state.logPath}`);
    if (!needsSupervisor) return 0;

    try {
      const supervisorState = await dependencies.startService({
        name: "supervisor",
        executable: dependencies.nodeExecutable,
        args: [CLI_SCRIPT, "supervise", "--config", resolve(dependencies.cwd, configPath)],
        marker: CLI_SCRIPT,
        env: dependencies.env,
        cwd: dependencies.cwd,
        stateDirectory,
        spawnProcess: dependencies.spawnProcess,
      });
      io.log(`Started the supervisor (${describeSupervisor(config)}) in the background (pid ${supervisorState.pid}).`);
      io.log(`Log file: ${supervisorState.logPath}`);
      return 0;
    } catch (error) {
      io.error(error.message);
      io.error("Stopping celld because the supervisor did not start.");
      await dependencies.stopService({ stateDirectory }).catch((stopError) => io.error(stopError.message));
      return 1;
    }
  }

  let supervisor;
  if (needsSupervisor) {
    try {
      supervisor = await startSupervisorRuntime(config, io, { ...dependencies, stateDirectory, executable, storageArgs });
    } catch (error) {
      io.error(error.message);
      return 1;
    }
  }

  // Service managers (launchd, systemd KillMode=mixed) signal only this
  // process, so forward SIGTERM to let celld flush and exit cleanly. A
  // terminal SIGINT already reaches celld through the process group.
  let child;
  const unsubscribe = [
    dependencies.onSignal("SIGTERM", () => child?.kill("SIGTERM")),
    dependencies.onSignal("SIGINT", () => {}),
  ];
  if (supervisor?.reloadCertificates) {
    unsubscribe.push(dependencies.onSignal("SIGHUP", () => reloadCertificates(supervisor, io)));
  }
  try {
    return await runProcess(
      executable,
      argsForCelld,
      io,
      dependencies.spawnProcess,
      undefined,
      {},
      "celld",
      (spawned) => { child = spawned; },
    );
  } finally {
    for (const off of unsubscribe) off();
    await supervisor?.close();
  }
}

async function runSupervise(args, io, dependencies) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    io.log(superviseHelpText);
    return 0;
  }
  const options = parseConfigOptions(args, io, "supervise");
  if (!options) return 2;

  let config;
  try {
    config = await dependencies.loadConfig(resolve(dependencies.cwd, options.configPath));
  } catch (error) {
    io.error(error.message);
    return 2;
  }
  if (!config.ingress && !config.admin) {
    io.error(`No [ingress] or [admin] table in ${options.configPath}; there is nothing to supervise.`);
    return 2;
  }

  let supervisor;
  try {
    const executable = config.admin ? await resolveCelld(dependencies) : undefined;
    supervisor = await startSupervisorRuntime(config, io, {
      ...dependencies,
      executable,
      storageArgs: celldStorageArgs(config),
      stateDirectory: defaultStateDirectory(dependencies.env),
    });
  } catch (error) {
    io.error(error.message);
    return 1;
  }

  return new Promise((resolvePromise) => {
    const unsubscribe = [];
    const stop = (code) => {
      for (const off of unsubscribe) off();
      supervisor.close().then(() => resolvePromise(code));
    };
    unsubscribe.push(dependencies.onSignal("SIGINT", () => stop(130)));
    unsubscribe.push(dependencies.onSignal("SIGTERM", () => stop(0)));
    if (supervisor.reloadCertificates) {
      unsubscribe.push(dependencies.onSignal("SIGHUP", () => reloadCertificates(supervisor, io)));
    }
  });
}

function reloadCertificates(supervisor, io) {
  try {
    supervisor.reloadCertificates();
    io.log("Reloaded ingress TLS certificates.");
  } catch (error) {
    io.error(`Kept the previous certificates: ${error.message}`);
  }
}

function celldStorageArgs(config) {
  const args = ["--bucket", config.bucket];
  if (config.endpoint) args.push("--endpoint", config.endpoint);
  if (config.region) args.push("--region", config.region);
  return args;
}

function describeSupervisor(config) {
  const parts = [];
  if (config.ingress) parts.push(`ingress on ${config.ingress.listen}`);
  if (config.admin) parts.push(`admin API on ${config.admin.listen}`);
  return parts.join(", ");
}

// The supervisor hosts everything sobjects runs beside celld: the TLS ingress
// and the loopback admin API, which share the ingress request metrics.
async function startSupervisorRuntime(config, io, dependencies) {
  const closers = [];
  const close = async () => {
    for (const closer of closers.reverse()) await closer();
  };
  const metrics = createIngressMetrics();
  let ingress;
  try {
    if (config.ingress) {
      const accessLog = await openAccessLog(config.ingress.accessLog ?? join(dependencies.stateDirectory, "access.log"), io);
      closers.push(accessLog.close);
      ingress = await dependencies.startIngressServer({
        listen: config.ingress.listen,
        redirectHttp: config.ingress.redirectHttp,
        tls: config.ingress.tls,
        acme: config.ingress.acme,
        stateDirectory: dependencies.stateDirectory,
        routes: config.ingress.routes,
        accessLog: (entry) => {
          metrics.observe(entry);
          accessLog.write(entry);
        },
        log: (message) => io.log(message),
      });
      closers.push(ingress.close);
      const scheme = config.ingress.tls || config.ingress.acme ? "https" : "http";
      io.log(`Ingress listening on ${scheme}://${config.ingress.listen} for ${config.ingress.routes.map((route) => route.hostname).join(", ")}.`);
    }
    if (config.admin) {
      const engine = dependencies.createEngine({
        listen: config.listen,
        internalListen: config.internalListen,
        executable: dependencies.executable,
        storageArgs: dependencies.storageArgs,
        inspectorToken: await dependencies.readToken(defaultDataDirectory(dependencies.env)),
        env: dependencies.env,
      });
      const admin = await dependencies.startAdminServer({ listen: config.admin.listen, engine, metrics, version });
      closers.push(admin.close);
      io.log(`Admin API listening on http://${config.admin.listen} (metrics at /metrics).`);
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { reloadCertificates: ingress?.reloadCertificates, close };
}

async function openAccessLog(target, io) {
  if (target === "-") {
    return { write: (entry) => io.log(JSON.stringify(entry)), close: async () => {} };
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const stream = createWriteStream(target, { flags: "a", mode: 0o600 });
  await new Promise((resolvePromise, reject) => {
    stream.once("open", resolvePromise);
    stream.once("error", (error) => reject(new Error(`Could not open access log ${target}: ${error.message}`)));
  });
  return {
    write: (entry) => stream.write(`${JSON.stringify(entry)}\n`),
    close: () => new Promise((resolvePromise) => stream.end(resolvePromise)),
  };
}

function parseConfigOptions(args, io, command, { allowDetach = false } = {}) {
  let configPath = "sobjects.toml";
  let detached = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (allowDetach && (argument === "--detach" || argument === "-d")) {
      detached = true;
    } else if (argument === "--config") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        io.error("Option --config requires a path.");
        return undefined;
      }
      configPath = value;
      index += 1;
    } else if (argument.startsWith("--config=")) {
      configPath = argument.slice("--config=".length);
      if (!configPath) {
        io.error("Option --config requires a path.");
        return undefined;
      }
    } else {
      io.error(`Unknown sobjects ${command} option: ${argument}`);
      io.error(`Run 'sobjects ${command} --help' for usage.`);
      return undefined;
    }
  }
  return { configPath, detached };
}

async function runService(args, io, { env, cwd, loadConfig, nodeExecutable, platform = process.platform }) {
  const [action, ...rest] = args;
  if (!action || ["--help", "-h"].includes(action)) {
    io.log(serviceHelpText);
    return action ? 0 : 2;
  }
  if (action !== "print" && action !== "install") {
    io.error(`Unknown sobjects service action: ${action}`);
    io.error("Run 'sobjects service --help' for usage.");
    return 2;
  }

  const options = { configPath: "sobjects.toml", kind: platform === "darwin" ? "launchd" : "systemd", system: false, force: false };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    const takeValue = () => {
      const value = rest[index + 1];
      index += 1;
      if (!value || value.startsWith("--")) throw new Error(`Option ${argument} requires a value.`);
      return value;
    };
    try {
      if (argument === "--config") options.configPath = takeValue();
      else if (argument === "--kind") options.kind = takeValue();
      else if (argument === "--user") options.user = takeValue();
      else if (argument === "--system") options.system = true;
      else if (argument === "--force" && action === "install") options.force = true;
      else throw new Error(`Unknown sobjects service option: ${argument}`);
    } catch (error) {
      io.error(error.message);
      return 2;
    }
  }
  if (!["systemd", "launchd"].includes(options.kind)) {
    io.error("--kind must be systemd or launchd.");
    return 2;
  }
  if (options.user && !options.system) {
    io.error("--user applies only to --system units.");
    return 2;
  }

  const configPath = resolve(cwd, options.configPath);
  try {
    // Validate now so a broken config fails here rather than in a restart loop.
    await loadConfig(configPath);
  } catch (error) {
    io.error(error.message);
    return 2;
  }

  // Pin the state and data directories the unit will use, since service
  // managers do not inherit the shell's XDG variables. A system unit runs as
  // another account and uses the directory systemd creates for it.
  const unitEnv = options.system
    ? { SOBJECTS_STATE_DIR: "/var/lib/serverless-objects/state", SOBJECTS_DATA_DIR: "/var/lib/serverless-objects" }
    : { SOBJECTS_STATE_DIR: defaultStateDirectory(env), SOBJECTS_DATA_DIR: defaultDataDirectory(env) };
  if (env.SOBJECTS_CELLD_BIN) unitEnv.SOBJECTS_CELLD_BIN = env.SOBJECTS_CELLD_BIN;
  let contents;
  let target;
  try {
    contents = options.kind === "launchd"
      ? renderLaunchdPlist({ nodeExecutable, cliScript: CLI_SCRIPT, configPath, logDirectory: unitEnv.SOBJECTS_STATE_DIR, env: unitEnv })
      : renderSystemdUnit({ nodeExecutable, cliScript: CLI_SCRIPT, configPath, system: options.system, user: options.user, env: unitEnv });
    target = unitTarget({ kind: options.kind, system: options.system, env });
  } catch (error) {
    io.error(error.message);
    return 2;
  }

  if (action === "print") {
    io.log(contents.trimEnd());
    return 0;
  }
  try {
    await writeUnit(target.path, contents, { force: options.force });
  } catch (error) {
    io.error(error.message);
    return 1;
  }
  io.log(`Wrote ${target.path}.`);
  io.log("Enable and start it with:");
  for (const command of target.next) io.log(`  ${command}`);
  return 0;
}

function celldShutdownBoundMs(env) {
  const value = Number(env.CELLD_SHUTDOWN_TOTAL_MS);
  return Number.isInteger(value) && value > 0 ? value : 40_000;
}

function isLoopbackAddress(address) {
  const host = address.slice(0, address.lastIndexOf(":")).replace(/^\[(.*)\]$/, "$1");
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

function subscribeToSignal(signal, handler) {
  process.on(signal, handler);
  return () => process.off(signal, handler);
}

async function runStatus(args, io, { env, getServiceStatus }) {
  if (args.length > 0) {
    io.error("Usage: sobjects status");
    return 2;
  }
  const stateDirectory = defaultStateDirectory(env);
  try {
    const result = await getServiceStatus({ stateDirectory });
    if (result.running) {
      io.log(`celld is running (pid ${result.state.pid}; started ${result.state.startedAt}).`);
      io.log(`Log file: ${result.state.logPath}`);
    } else {
      io.log(result.stale ? "celld is not running (stale state removed)." : "celld is not running.");
    }

    const supervisor = await getServiceStatus({ name: "supervisor", stateDirectory });
    if (supervisor.running) {
      io.log(`supervisor is running (pid ${supervisor.state.pid}; started ${supervisor.state.startedAt}).`);
      io.log(`Log file: ${supervisor.state.logPath}`);
    } else if (supervisor.stale) {
      io.log("supervisor is not running (stale state removed).");
    }
    return result.running && !supervisor.stale ? 0 : 1;
  } catch (error) {
    io.error(error.message);
    return 1;
  }
}

async function runDown(args, io, { env, stopService }) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    io.log("Usage: sobjects down");
    return 0;
  }
  if (args.length > 0) {
    io.error("Usage: sobjects down");
    return 2;
  }
  const stateDirectory = defaultStateDirectory(env);
  let exitCode = 0;
  // Stop the supervisor first so clients see a refused connection rather than a 502.
  for (const name of ["supervisor", "celld"]) {
    try {
      const options = { name, stateDirectory };
      if (name === "celld") {
        // celld drains cells and releases its lease before exiting, bounded by
        // CELLD_SHUTDOWN_TOTAL_MS; wait a little longer than that bound.
        options.timeoutMs = celldShutdownBoundMs(env) + 5_000;
        options.onWait = () => io.log("Waiting for celld to drain and release its lease...");
      }
      const result = await stopService(options);
      if (result.stopped) io.log(`Stopped ${name} (pid ${result.state.pid}).`);
      else if (result.stale) io.log(`${name} was not running (stale state removed).`);
      else if (name === "celld") io.log("celld is not running.");
    } catch (error) {
      io.error(error.message);
      exitCode = 1;
    }
  }
  return exitCode;
}

async function runLogs(args, io, { env, readServiceLogs }) {
  const usage = "Usage: sobjects logs [--supervisor] [--tail N]";
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    io.log(usage);
    return 0;
  }
  let lines = 100;
  let name = "celld";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let value;
    if (argument === "--supervisor") {
      name = "supervisor";
      continue;
    } else if (argument === "--tail" || argument === "-n") {
      value = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--tail=")) {
      value = argument.slice("--tail=".length);
    } else {
      io.error(usage);
      return 2;
    }
    lines = Number(value);
    if (!Number.isInteger(lines) || lines < 1 || lines > 10_000) {
      io.error("--tail requires a number from 1 to 10000.");
      return 2;
    }
  }
  try {
    const result = await readServiceLogs({ name, stateDirectory: defaultStateDirectory(env), lines });
    if (result.output) io.log(result.output);
    return 0;
  } catch (error) {
    io.error(error.message);
    return 1;
  }
}

async function runCelld(command, args, io, dependencies) {
  let effectiveArgs = args;
  if (command === "deploy") {
    try {
      effectiveArgs = await deployArgsFromConfig(args, dependencies);
    } catch (error) {
      io.error(error.message);
      return 2;
    }
  }

  // Deploys carry storage inspection hooks unless --no-inspector is passed.
  let inspectorTokenHash;
  if (command === "deploy") {
    if (effectiveArgs.includes("--no-inspector")) {
      effectiveArgs = effectiveArgs.filter((argument) => argument !== "--no-inspector");
    } else {
      try {
        inspectorTokenHash = tokenHash(await dependencies.ensureToken(defaultDataDirectory(dependencies.env)));
      } catch (error) {
        io.error(error.message);
        return 1;
      }
    }
  }

  let prepared;
  try {
    prepared = await dependencies.prepareProject(effectiveArgs, { cwd: dependencies.cwd, inspectorTokenHash });
  } catch (error) {
    io.error(error.message);
    return 2;
  }

  for (const warning of prepared.warnings) io.error(`Warning: ${warning}`);
  try {
    const childEnv = projectEnvironment(prepared.args, dependencies.env, dependencies.cwd);
    if (prepared.buildCommand) {
      const buildExitCode = await runProcess(
        prepared.buildCommand,
        [],
        io,
        dependencies.spawnProcess,
        childEnv,
        { shell: true, cwd: prepared.buildDirectory },
        "Wrangler build.command",
      );
      if (buildExitCode !== 0) return buildExitCode;
    }
    try {
      await prepared.afterBuild?.();
    } catch (error) {
      io.error(error.message);
      return 2;
    }

    let executable;
    try {
      executable = await resolveCelld(dependencies);
    } catch (error) {
      io.error(error.message);
      return 1;
    }
    return await runProcess(
      executable,
      [command, ...prepared.args],
      io,
      dependencies.spawnProcess,
      childEnv,
    );
  } finally {
    await prepared.cleanup();
  }
}

async function resolveCelld({ env, installEngine, readSelection }) {
  if (env.SOBJECTS_CELLD_BIN) return env.SOBJECTS_CELLD_BIN;
  const dataDirectory = defaultDataDirectory(env);
  const selection = await readSelection(dataDirectory);
  return installEngine({ dataDirectory, version: selection?.version ?? CELLD_VERSION });
}

async function runUpgrade(args, io, { env, installEngine, readSelection, writeSelection, isInstalled, getServiceStatus }) {
  const usage = "Usage: sobjects upgrade [--engine-version VERSION | --rollback | --status]";
  let mode = "upgrade";
  let target = CELLD_VERSION;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["--help", "-h"].includes(argument)) {
      io.log(`${usage}

Install and select a pinned celld release (default: ${CELLD_VERSION}, the
version this CLI pins). --rollback selects the previously selected version.
Known versions: ${Object.keys(CELLD_RELEASES).join(", ")}. The running node
keeps its version until it is restarted.`);
      return 0;
    }
    if (argument === "--rollback") mode = "rollback";
    else if (argument === "--status") mode = "status";
    else if (argument === "--engine-version") {
      target = args[index + 1];
      index += 1;
      if (!target) {
        io.error("Option --engine-version requires a version.");
        return 2;
      }
    } else if (argument.startsWith("--engine-version=")) {
      target = argument.slice("--engine-version=".length);
    } else {
      io.error(usage);
      return 2;
    }
  }
  if (mode !== "upgrade" && args.length !== 1) {
    io.error(usage);
    return 2;
  }
  target = target.replace(/^v/, "");

  const dataDirectory = defaultDataDirectory(env);
  let selection;
  try {
    selection = await readSelection(dataDirectory);
  } catch (error) {
    io.error(error.message);
    return 1;
  }
  const current = selection?.version ?? CELLD_VERSION;
  if (env.SOBJECTS_CELLD_BIN) {
    io.error(`Warning: SOBJECTS_CELLD_BIN=${env.SOBJECTS_CELLD_BIN} overrides the selected celld version.`);
  }

  if (mode === "status") {
    io.log(`Selected celld: ${current}${selection ? "" : " (CLI default)"}`);
    if (selection?.previous) io.log(`Rollback target: ${selection.previous}`);
    for (const version of Object.keys(CELLD_RELEASES)) {
      const installed = await isInstalled(dataDirectory, version);
      io.log(`  ${version === current ? "*" : " "} ${version}${installed ? " (installed)" : ""}`);
    }
    return 0;
  }

  if (mode === "rollback") {
    if (!selection?.previous) {
      io.error("No previous celld version is recorded; nothing to roll back to.");
      return 1;
    }
    target = selection.previous;
  }
  if (!CELLD_RELEASES[target]) {
    io.error(`celld ${target} is not a pinned release. Known versions: ${Object.keys(CELLD_RELEASES).join(", ")}.`);
    return 2;
  }
  if (target === current) {
    try {
      await installEngine({ dataDirectory, version: target });
    } catch (error) {
      io.error(error.message);
      return 1;
    }
    io.log(`celld ${target} is already selected and installed.`);
    return 0;
  }

  try {
    await installEngine({ dataDirectory, version: target });
    await writeSelection(dataDirectory, { version: target, previous: current, selectedAt: new Date().toISOString() });
  } catch (error) {
    io.error(error.message);
    io.error(`celld ${current} remains selected.`);
    return 1;
  }
  io.log(`Selected celld ${target} (was ${current}). Roll back with 'sobjects upgrade --rollback'.`);
  try {
    const status = await getServiceStatus({ stateDirectory: defaultStateDirectory(env) });
    if (status.running) {
      io.log("The detached node still runs the old version; restart it with 'sobjects down' and 'sobjects up --detach'.");
    }
  } catch {
    // Status is advisory here.
  }
  io.log("Restart any service unit running 'sobjects up' to use the new version.");
  return 0;
}

function runProcess(executable, args, io, spawnProcess, env, extraOptions = {}, errorContext = "celld", onSpawn) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolvePromise(code);
    };

    let child;
    try {
      const options = { stdio: "inherit", ...extraOptions };
      if (env) options.env = env;
      child = spawnProcess(executable, args, options);
      onSpawn?.(child);
    } catch (error) {
      reportProcessError(error, executable, io, errorContext);
      finish(error.code === "ENOENT" && errorContext === "celld" ? 127 : 1);
      return;
    }

    child.once("error", (error) => {
      reportProcessError(error, executable, io, errorContext);
      finish(error.code === "ENOENT" && errorContext === "celld" ? 127 : 1);
    });
    child.once("exit", (code, signal) => {
      if (typeof code === "number") {
        finish(code);
      } else if (signal === "SIGINT") {
        finish(130);
      } else if (signal === "SIGTERM") {
        finish(143);
      } else {
        finish(1);
      }
    });
  });
}

function reportProcessError(error, executable, io, context) {
  if (context === "celld") {
    reportSpawnError(error, executable, io);
  } else {
    io.error(`Could not start ${context}: ${error.message}`);
  }
}

async function deployArgsFromConfig(args, { cwd, env, loadConfig }) {
  const configPath = join(projectDirectory(args, cwd), "sobjects.toml");
  try {
    await access(configPath);
  } catch (error) {
    if (error.code === "ENOENT") return args;
    throw new Error(`Could not access ${configPath}: ${error.message}`);
  }

  const config = await loadConfig(configPath);
  const result = [...args];
  if (!hasOption(result, "--bucket") && !env.CELLD_BUCKET) {
    result.push("--bucket", config.bucket);
  }
  if (config.endpoint && !hasOption(result, "--endpoint") && !env.S3_ENDPOINT) {
    result.push("--endpoint", config.endpoint);
  }
  if (config.region && !hasOption(result, "--region") && !env.AWS_REGION && !env.AWS_DEFAULT_REGION) {
    result.push("--region", config.region);
  }
  return result;
}

function hasOption(args, name) {
  return args.some((argument) => argument === name || argument.startsWith(`${name}=`));
}

function projectDirectory(args, cwd) {
  const firstArgument = args[0];
  const projectArgument = firstArgument && !firstArgument.startsWith("-")
    ? firstArgument
    : ".";
  const projectPath = resolve(cwd, projectArgument);
  try {
    if (statSync(projectPath).isFile()) return dirname(projectPath);
  } catch {
    // Let celld report a missing project with its normal diagnostic.
  }
  return projectPath;
}

// celld deploy bundles with esbuild from PATH. The bundled copy comes last so
// a project-local or system esbuild still wins.
function projectEnvironment(args, env, cwd) {
  const localBin = join(projectDirectory(args, cwd), "node_modules", ".bin");
  const pathValue = env.PATH ?? env.Path ?? "";
  return {
    ...env,
    PATH: [localBin, pathValue, BUNDLED_ESBUILD_BIN].filter(Boolean).join(delimiter),
  };
}

function bundledEsbuildDirectory() {
  try {
    return dirname(createRequire(import.meta.url).resolve("esbuild/bin/esbuild"));
  } catch {
    return undefined;
  }
}

function reportSpawnError(error, executable, io) {
  if (error.code === "ENOENT") {
    io.error(`Could not find celld executable '${executable}'.`);
    io.error("Install celld v0.6.2 or set SOBJECTS_CELLD_BIN to its path.");
    return;
  }
  io.error(`Could not start celld: ${error.message}`);
}

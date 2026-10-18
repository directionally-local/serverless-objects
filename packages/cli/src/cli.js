import { spawn } from "node:child_process";
import { createWriteStream, readFileSync, statSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSobjectsConfig } from "./config.js";
import { defaultDataDirectory, installCelld } from "./engine.js";
import { HEALTH_PATH, startIngress } from "./ingress.js";
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

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const helpText = `Serverless Objects — self-hostable Workers infrastructure for agents

Usage: sobjects <command> [options]

Commands:
  up [--config PATH] [--detach]  Start a celld node and its ingress, if configured
  down                           Stop a detached node and ingress
  status                         Show detached process status
  logs [--ingress] [--tail N]    Show recent detached celld or ingress logs
  ingress [--config PATH]        Run only the TLS ingress in the foreground
  service print|install [opts]   Generate a systemd or launchd unit for up
  dev [project] [options]        Run a project locally with celld
  deploy [project] [options]     Deploy a project with celld

Options:
  -h, --help      Show this help
  -v, --version   Show the installed version

The CLI installs the pinned celld v0.6.2 release on first use. Set
SOBJECTS_CELLD_BIN to use an existing binary instead.`;

const upHelpText = `Usage: sobjects up [--config PATH] [--detach]

Read [celld] settings from sobjects.toml, install pinned celld if needed, and
run the node in the foreground by default. When [ingress] is configured, the
TLS ingress starts first and proxies to celld. Use --detach to run both in the
background. The default config path is ./sobjects.toml.`;

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

const ingressHelpText = `Usage: sobjects ingress [--config PATH]

Run the ingress described by [ingress] in sobjects.toml in the foreground.
SIGHUP reloads TLS certificates from disk. Health: ${HEALTH_PATH}`;

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
    onSignal = subscribeToSignal,
    nodeExecutable = process.execPath,
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
    });
  }
  if (command === "ingress") {
    return runIngress(args, io, { env, cwd, loadConfig, startIngressServer, onSignal });
  }
  if (command === "service") {
    return runService(args, io, { env, cwd, loadConfig, nodeExecutable, platform: dependencies.platform });
  }
  if (command === "down") return runDown(args, io, { env, stopService });
  if (command === "status") return runStatus(args, io, { env, getServiceStatus });
  if (command === "logs") return runLogs(args, io, { env, readServiceLogs });
  if (command === "dev" || command === "deploy") {
    return runCelld(command, args, io, { spawnProcess, env, cwd, installEngine, prepareProject, loadConfig });
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
    executable = await resolveCelld(dependencies.env, dependencies.installEngine);
  } catch (error) {
    io.error(error.message);
    return 1;
  }

  const argsForCelld = ["--bucket", config.bucket, "--listen", config.listen];
  if (config.endpoint) argsForCelld.push("--endpoint", config.endpoint);
  if (config.region) argsForCelld.push("--region", config.region);
  const stateDirectory = defaultStateDirectory(dependencies.env);
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
    if (!config.ingress) return 0;

    try {
      const ingressState = await dependencies.startService({
        name: "ingress",
        executable: dependencies.nodeExecutable,
        args: [CLI_SCRIPT, "ingress", "--config", resolve(dependencies.cwd, configPath)],
        marker: CLI_SCRIPT,
        env: dependencies.env,
        cwd: dependencies.cwd,
        stateDirectory,
        spawnProcess: dependencies.spawnProcess,
      });
      io.log(`Started ingress on ${config.ingress.listen} in the background (pid ${ingressState.pid}).`);
      io.log(`Log file: ${ingressState.logPath}`);
      return 0;
    } catch (error) {
      io.error(error.message);
      io.error("Stopping celld because the ingress did not start.");
      await dependencies.stopService({ stateDirectory }).catch((stopError) => io.error(stopError.message));
      return 1;
    }
  }

  let ingress;
  if (config.ingress) {
    try {
      ingress = await startIngressRuntime(config.ingress, io, { ...dependencies, stateDirectory });
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
  if (ingress) {
    unsubscribe.push(dependencies.onSignal("SIGHUP", () => {
      try {
        ingress.reloadCertificates();
        io.log("Reloaded ingress TLS certificates.");
      } catch (error) {
        io.error(`Kept the previous certificates: ${error.message}`);
      }
    }));
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
    await ingress?.close();
  }
}

async function runIngress(args, io, dependencies) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    io.log(ingressHelpText);
    return 0;
  }
  const options = parseConfigOptions(args, io, "ingress");
  if (!options) return 2;

  let config;
  try {
    config = await dependencies.loadConfig(resolve(dependencies.cwd, options.configPath));
  } catch (error) {
    io.error(error.message);
    return 2;
  }
  if (!config.ingress) {
    io.error(`No [ingress] table in ${options.configPath}.`);
    return 2;
  }

  let ingress;
  try {
    ingress = await startIngressRuntime(config.ingress, io, {
      ...dependencies,
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
      ingress.close().then(() => resolvePromise(code));
    };
    unsubscribe.push(dependencies.onSignal("SIGINT", () => stop(130)));
    unsubscribe.push(dependencies.onSignal("SIGTERM", () => stop(0)));
    unsubscribe.push(dependencies.onSignal("SIGHUP", () => {
      try {
        ingress.reloadCertificates();
        io.log("Reloaded ingress TLS certificates.");
      } catch (error) {
        io.error(`Kept the previous certificates: ${error.message}`);
      }
    }));
  });
}

async function startIngressRuntime(ingressConfig, io, { startIngressServer, stateDirectory }) {
  const accessLog = await openAccessLog(ingressConfig.accessLog ?? join(stateDirectory, "access.log"), io);
  let ingress;
  try {
    ingress = await startIngressServer({
      listen: ingressConfig.listen,
      redirectHttp: ingressConfig.redirectHttp,
      tls: ingressConfig.tls,
      routes: ingressConfig.routes,
      accessLog: accessLog.write,
    });
  } catch (error) {
    await accessLog.close();
    throw error;
  }
  const scheme = ingressConfig.tls ? "https" : "http";
  io.log(`Ingress listening on ${scheme}://${ingressConfig.listen} for ${ingressConfig.routes.map((route) => route.hostname).join(", ")}.`);
  return {
    reloadCertificates: ingress.reloadCertificates,
    close: async () => {
      await ingress.close();
      await accessLog.close();
    },
  };
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

    const ingress = await getServiceStatus({ name: "ingress", stateDirectory });
    if (ingress.running) {
      io.log(`ingress is running (pid ${ingress.state.pid}; started ${ingress.state.startedAt}).`);
      io.log(`Log file: ${ingress.state.logPath}`);
    } else if (ingress.stale) {
      io.log("ingress is not running (stale state removed).");
    }
    return result.running && !ingress.stale ? 0 : 1;
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
  // Stop the ingress first so clients see a refused connection rather than a 502.
  for (const name of ["ingress", "celld"]) {
    try {
      const result = await stopService({ name, stateDirectory });
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
  const usage = "Usage: sobjects logs [--ingress] [--tail N]";
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    io.log(usage);
    return 0;
  }
  let lines = 100;
  let name = "celld";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let value;
    if (argument === "--ingress") {
      name = "ingress";
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

  let prepared;
  try {
    prepared = await dependencies.prepareProject(effectiveArgs, { cwd: dependencies.cwd });
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
      executable = await resolveCelld(dependencies.env, dependencies.installEngine);
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

async function resolveCelld(env, installEngine) {
  if (env.SOBJECTS_CELLD_BIN) return env.SOBJECTS_CELLD_BIN;
  return installEngine({ dataDirectory: defaultDataDirectory(env) });
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

function projectEnvironment(args, env, cwd) {
  const localBin = join(projectDirectory(args, cwd), "node_modules", ".bin");
  const pathValue = env.PATH ?? env.Path ?? "";
  return {
    ...env,
    PATH: [localBin, pathValue].filter(Boolean).join(delimiter),
  };
}

function reportSpawnError(error, executable, io) {
  if (error.code === "ENOENT") {
    io.error(`Could not find celld executable '${executable}'.`);
    io.error("Install celld v0.6.2 or set SOBJECTS_CELLD_BIN to its path.");
    return;
  }
  io.error(`Could not start celld: ${error.message}`);
}

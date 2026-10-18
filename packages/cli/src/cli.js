import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { loadSobjectsConfig } from "./config.js";
import { defaultDataDirectory, installCelld } from "./engine.js";
import { prepareWranglerProject } from "./wrangler.js";
import {
  defaultStateDirectory,
  getCelldStatus,
  readCelldLogs,
  startCelldDetached,
  stopCelld,
} from "./service.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const helpText = `Serverless Objects — self-hostable Workers infrastructure for agents

Usage: sobjects <command> [options]

Commands:
  up [--config PATH] [--detach]  Start a celld node
  down                           Stop a detached celld node
  status                         Show detached celld process status
  logs [--tail N]                Show recent detached celld logs
  dev [project] [options]        Run a project locally with celld
  deploy [project] [options]     Deploy a project with celld

Options:
  -h, --help      Show this help
  -v, --version   Show the installed version

The CLI installs the pinned celld v0.6.2 release on first use. Set
SOBJECTS_CELLD_BIN to use an existing binary instead.`;

const upHelpText = `Usage: sobjects up [--config PATH] [--detach]

Read [celld] settings from sobjects.toml, install pinned celld if needed, and
run the node in the foreground by default. Use --detach to run it in the
background. The default config path is ./sobjects.toml.`;

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
    startService = startCelldDetached,
    getServiceStatus = getCelldStatus,
    readServiceLogs = readCelldLogs,
    stopService = stopCelld,
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
    return runUp(args, io, { spawnProcess, env, cwd, installEngine, loadConfig, startService });
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

  let configPath = "sobjects.toml";
  let detached = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--detach" || argument === "-d") {
      detached = true;
    } else if (argument === "--config") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        io.error("Option --config requires a path.");
        return 2;
      }
      configPath = value;
      index += 1;
    } else if (argument.startsWith("--config=")) {
      configPath = argument.slice("--config=".length);
      if (!configPath) {
        io.error("Option --config requires a path.");
        return 2;
      }
    } else {
      io.error(`Unknown sobjects up option: ${argument}`);
      io.error("Run 'sobjects up --help' for usage.");
      return 2;
    }
  }

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
  if (detached) {
    try {
      const state = await dependencies.startService({
        executable,
        args: argsForCelld,
        env: dependencies.env,
        cwd: dependencies.cwd,
        stateDirectory: defaultStateDirectory(dependencies.env),
        spawnProcess: dependencies.spawnProcess,
      });
      io.log(`Started celld in the background (pid ${state.pid}).`);
      io.log(`Log file: ${state.logPath}`);
      return 0;
    } catch (error) {
      io.error(error.message);
      return 1;
    }
  }
  return runProcess(executable, argsForCelld, io, dependencies.spawnProcess);
}

async function runStatus(args, io, { env, getServiceStatus }) {
  if (args.length > 0) {
    io.error("Usage: sobjects status");
    return 2;
  }
  try {
    const result = await getServiceStatus({ stateDirectory: defaultStateDirectory(env) });
    if (!result.running) {
      io.log(result.stale ? "celld is not running (stale state removed)." : "celld is not running.");
      return 1;
    }
    io.log(`celld is running (pid ${result.state.pid}; started ${result.state.startedAt}).`);
    io.log(`Log file: ${result.state.logPath}`);
    return 0;
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
  try {
    const result = await stopService({ stateDirectory: defaultStateDirectory(env) });
    if (result.stopped) io.log(`Stopped celld (pid ${result.state.pid}).`);
    else io.log(result.stale ? "celld was not running (stale state removed)." : "celld is not running.");
    return 0;
  } catch (error) {
    io.error(error.message);
    return 1;
  }
}

async function runLogs(args, io, { env, readServiceLogs }) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    io.log("Usage: sobjects logs [--tail N]");
    return 0;
  }
  let lines = 100;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--tail" || argument === "-n") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 10_000) {
        io.error("--tail requires a number from 1 to 10000.");
        return 2;
      }
      lines = value;
      index += 1;
    } else if (argument.startsWith("--tail=")) {
      const value = Number(argument.slice("--tail=".length));
      if (!Number.isInteger(value) || value < 1 || value > 10_000) {
        io.error("--tail requires a number from 1 to 10000.");
        return 2;
      }
      lines = value;
    } else {
      io.error("Usage: sobjects logs [--tail N]");
      return 2;
    }
  }
  try {
    const result = await readServiceLogs({ stateDirectory: defaultStateDirectory(env), lines });
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

function runProcess(executable, args, io, spawnProcess, env, extraOptions = {}, errorContext = "celld") {
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

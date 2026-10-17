import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { loadSobjectsConfig } from "./config.js";
import { defaultDataDirectory, installCelld } from "./engine.js";
import { prepareWranglerProject } from "./wrangler.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const helpText = `Serverless Objects — self-hostable Workers infrastructure for agents

Usage: sobjects <command> [options]

Commands:
  up [--config PATH]          Start a celld node in the foreground
  dev [project] [options]     Run a project locally with celld
  deploy [project] [options]  Deploy a project with celld

Options:
  -h, --help      Show this help
  -v, --version   Show the installed version

The CLI installs the pinned celld v0.6.2 release on first use. Set
SOBJECTS_CELLD_BIN to use an existing binary instead.`;

const upHelpText = `Usage: sobjects up [--config PATH]

Read [celld] settings from sobjects.toml, install pinned celld if needed, and
run the node in the foreground. The default config path is ./sobjects.toml.`;

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
    return runUp(args, io, { spawnProcess, env, cwd, installEngine, loadConfig });
  }
  if (command === "dev" || command === "deploy") {
    return runCelld(command, args, io, { spawnProcess, env, cwd, installEngine, prepareProject });
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
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--config") {
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
  return runProcess(executable, argsForCelld, io, dependencies.spawnProcess);
}

async function runCelld(command, args, io, dependencies) {
  let prepared;
  try {
    prepared = await dependencies.prepareProject(args, { cwd: dependencies.cwd });
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

function projectEnvironment(args, env, cwd) {
  const firstArgument = args[0];
  const projectArgument = firstArgument && !firstArgument.startsWith("-")
    ? firstArgument
    : ".";
  const projectPath = resolve(cwd, projectArgument);
  let projectDirectory = projectPath;
  try {
    if (statSync(projectPath).isFile()) projectDirectory = dirname(projectPath);
  } catch {
    // Let celld report a missing project with its normal diagnostic.
  }
  const localBin = join(projectDirectory, "node_modules", ".bin");
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

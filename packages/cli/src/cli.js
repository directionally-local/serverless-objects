import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const helpText = `Serverless Objects — self-hostable Workers infrastructure for agents

Usage: sobjects <command> [options]

Commands:
  dev [project] [options]     Run a project locally with celld
  deploy [project] [options]  Deploy a project with celld

Options:
  -h, --help      Show this help
  -v, --version   Show the installed version

The dev and deploy commands pass their arguments through to celld. Project-local
binaries are added to PATH. Install celld separately for now; 'sobjects up' and
config validation are not available yet.`;

export async function run(
  argv = process.argv.slice(2),
  io = console,
  { spawnProcess = spawn, env = process.env, cwd = process.cwd() } = {},
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
  if (command === "dev" || command === "deploy") {
    return runCelld(command, args, io, spawnProcess, env, cwd);
  }

  io.error(`Unknown option or command: ${command}`);
  io.error("Run 'sobjects --help' to see the available commands.");
  return 2;
}

function runCelld(command, args, io, spawnProcess, env, cwd) {
  const executable = env.SOBJECTS_CELLD_BIN || "celld";
  const childEnv = projectEnvironment(args, env, cwd);

  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolvePromise(code);
    };

    let child;
    try {
      child = spawnProcess(executable, [command, ...args], {
        stdio: "inherit",
        env: childEnv,
      });
    } catch (error) {
      reportSpawnError(error, executable, io);
      finish(127);
      return;
    }

    child.once("error", (error) => {
      reportSpawnError(error, executable, io);
      finish(error.code === "ENOENT" ? 127 : 1);
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
  const childEnv = {
    ...env,
    PATH: [localBin, pathValue].filter(Boolean).join(delimiter),
  };
  return childEnv;
}

function reportSpawnError(error, executable, io) {
  if (error.code === "ENOENT") {
    io.error(`Could not find celld executable '${executable}'.`);
    io.error("Install celld v0.6.2 or set SOBJECTS_CELLD_BIN to its path.");
    return;
  }
  io.error(`Could not start celld: ${error.message}`);
}

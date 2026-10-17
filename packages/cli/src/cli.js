import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const helpText = `Serverless Objects — self-hostable Workers infrastructure for agents

Usage: sobjects [options]

Options:
  -h, --help      Show this help
  -v, --version   Show the installed version

The v0.1 CLI is being built; no engine or deployment commands are available yet.`;

export function run(argv = process.argv.slice(2), io = console) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    io.log(helpText);
    return 0;
  }

  if (argv.length === 1 && ["--version", "-v", "version"].includes(argv[0])) {
    io.log(version);
    return 0;
  }

  io.error(`Unknown option or command: ${argv[0]}`);
  io.error("Run 'sobjects --help' to see the available options.");
  return 2;
}

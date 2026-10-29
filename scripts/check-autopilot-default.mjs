// Checks the autopilot-ai version the cell executor installs by default against
// the latest on npm. CI runs this on every push and pull request. A default a
// major release behind fails the build, because the bridge protocol may have
// changed; a default more than a minor behind only warns, because a new
// Autopilot release should not break an unrelated change.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const EXECUTOR = new URL("../packages/cli/autopilot/cell-executor.js", import.meta.url);
const REGISTRY = "https://registry.npmjs.org/autopilot-ai/latest";

export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!match) throw new Error(`not a version: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

// A newer major on npm means the bridge protocol may have changed, so the
// default must be re-checked rather than left to drift.
export function isMajorBehind(defaultVersion, latestVersion) {
  return parseVersion(latestVersion).major > parseVersion(defaultVersion).major;
}

// "More than a minor behind" means a newer major, or two or more minors within
// the same major. A default ahead of npm (an unreleased pin) is not behind.
export function isBehind(defaultVersion, latestVersion) {
  const pinned = parseVersion(defaultVersion);
  const latest = parseVersion(latestVersion);
  if (latest.major !== pinned.major) return latest.major > pinned.major;
  return latest.minor - pinned.minor > 1;
}

export function defaultPackageVersion(source) {
  const match = /DEFAULT_PACKAGE = "autopilot-ai@([^"]+)"/.exec(source);
  if (!match) throw new Error("DEFAULT_PACKAGE not found in cell-executor.js");
  return match[1];
}

async function main() {
  const pinned = defaultPackageVersion(await readFile(EXECUTOR, "utf8"));
  let latest;
  try {
    const response = await fetch(REGISTRY, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`registry returned ${response.status}`);
    latest = (await response.json()).version;
  } catch (error) {
    console.log(`::warning::could not read the latest autopilot-ai version (${error.message}); the default is ${pinned}`);
    return;
  }
  if (isMajorBehind(pinned, latest)) {
    console.log(`::error::AutopilotCellRun installs autopilot-ai@${pinned} by default, but ${latest} is on npm. Bump DEFAULT_PACKAGE in packages/cli/autopilot/cell-executor.js and re-check the bridge protocol against the new major.`);
    process.exitCode = 1;
    return;
  }
  if (isBehind(pinned, latest)) {
    console.log(`::warning::AutopilotCellRun installs autopilot-ai@${pinned} by default, but ${latest} is on npm. Bump DEFAULT_PACKAGE in packages/cli/autopilot/cell-executor.js and re-check the bridge protocol.`);
    return;
  }
  console.log(`autopilot-ai default ${pinned} is current (latest ${latest})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

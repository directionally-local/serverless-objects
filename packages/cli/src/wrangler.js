import { randomUUID } from "node:crypto";
import { readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { inspectorClasses, renderInspectorEntry } from "./inspector.js";
import { parse, printParseErrorCode } from "jsonc-parser";

const CELLD_WRANGLER_KEYS = new Set([
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "durable_objects",
  "migrations",
  "assets",
  "services",
  "triggers",
  "vars",
  "d1_databases",
  "kv_namespaces",
  "queues",
  "workflows",
  "r2_buckets",
  "worker_loaders",
  "containers",
  "no_bundle",
  "define",
  "rules",
]);
const NORMALIZABLE_KEYS = new Set(["build", "observability", "upload_source_maps"]);

export async function prepareWranglerProject(args, { cwd = process.cwd(), inspectorTokenHash } = {}) {
  const projectArgument = args[0] && !args[0].startsWith("-") ? args[0] : ".";
  const projectPath = resolve(cwd, projectArgument);
  let configPath;
  try {
    const metadata = await stat(projectPath);
    if (metadata.isFile()) {
      configPath = projectPath;
    } else if (metadata.isDirectory()) {
      configPath = await findConfig(projectPath);
    }
  } catch {
    return passthrough(args);
  }
  if (!configPath) return passthrough(args);

  const source = await readFile(configPath, "utf8");
  const normalized = normalizeWranglerConfig(source, configPath);
  const projectDirectory = dirname(configPath);
  const needsViteAssets = normalized.requiresAssetsDirectory;
  let buildCommand = normalized.buildCommand;
  if (needsViteAssets) {
    if (!(await hasCloudflareVitePlugin(projectDirectory))) {
      throw new Error(
        `Wrangler config ${configPath} sets assets without assets.directory. Set the built asset path explicitly; automatic discovery is limited to projects using @cloudflare/vite-plugin.`,
      );
    }
    buildCommand ??= "vite build";
    normalized.warnings.push("Running the Cloudflare Vite build to discover Wrangler assets.directory.");
  }

  const result = {
    args: [...args],
    warnings: normalized.warnings,
    buildCommand,
    buildDirectory: projectDirectory,
    afterBuild: async () => {},
    cleanup: async () => {},
  };

  const suffix = `${process.pid}-${randomUUID()}`;
  let entryPath;
  const classes = inspectorClasses(normalized.config);
  if (inspectorTokenHash && typeof normalized.config.main === "string" && Object.keys(classes).length > 0) {
    // The entry sits beside the config so relative paths keep working, and it
    // imports the app's main module by absolute path.
    entryPath = join(projectDirectory, `.sobjects-entry-${suffix}.mjs`);
    await writeFile(entryPath, renderInspectorEntry({
      main: resolve(projectDirectory, normalized.config.main),
      classes,
      tokenHash: inspectorTokenHash,
    }), { mode: 0o600 });
    normalized.config.main = `./${basename(entryPath)}`;
    normalized.changed = true;
  }

  if (!normalized.changed) return result;

  const temporaryPath = join(projectDirectory, `.sobjects-wrangler-${suffix}.json`);
  const writeNormalizedConfig = () =>
    writeFile(temporaryPath, `${JSON.stringify(normalized.config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "w",
      mode: 0o600,
    });
  await writeNormalizedConfig();
  if (args[0] && !args[0].startsWith("-")) {
    result.args[0] = temporaryPath;
  } else {
    result.args.unshift(temporaryPath);
  }
  if (needsViteAssets) {
    result.afterBuild = async () => {
      const assetsDirectory = await discoverViteAssetsDirectory(projectDirectory, configPath);
      normalized.config.assets = { ...normalized.config.assets, directory: assetsDirectory };
      await writeNormalizedConfig();
    };
  }
  result.cleanup = async () => {
    for (const path of [temporaryPath, entryPath].filter(Boolean)) {
      await unlink(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
  return result;
}

export function normalizeWranglerConfig(source, sourceName = "wrangler.jsonc") {
  const errors = [];
  const config = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0];
    const precedingLines = source.slice(0, first.offset).split(/\r\n|\r|\n/);
    const line = precedingLines.length;
    const column = precedingLines.at(-1).length + 1;
    throw new Error(
      `Invalid Wrangler config ${sourceName}:${line}:${column}: ${printParseErrorCode(first.error)}.`,
    );
  }
  if (!isRecord(config)) throw new Error(`Wrangler config ${sourceName} must be a JSON object.`);

  const unsupported = Object.keys(config).filter(
    (key) => !CELLD_WRANGLER_KEYS.has(key) && !NORMALIZABLE_KEYS.has(key),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported Wrangler config keys for celld in ${sourceName}: ${unsupported.join(", ")}. Remove them or use Wrangler.`,
    );
  }

  const normalized = { ...config };
  const warnings = [];
  let buildCommand;
  let requiresAssetsDirectory = false;
  if (Object.hasOwn(normalized, "observability")) {
    delete normalized.observability;
    warnings.push("celld does not implement Wrangler observability settings; ignoring `observability`.");
  }
  if (Object.hasOwn(normalized, "upload_source_maps")) {
    delete normalized.upload_source_maps;
    warnings.push("celld does not upload source maps; ignoring `upload_source_maps`.");
  }
  if (Object.hasOwn(normalized, "build")) {
    const build = normalized.build;
    if (!isRecord(build) || typeof build.command !== "string" || !build.command.trim()) {
      throw new Error(`Wrangler config ${sourceName} has an invalid build command; set build.command to a non-empty string.`);
    }
    const unsupportedBuildKeys = Object.keys(build).filter((key) => key !== "command");
    if (unsupportedBuildKeys.length > 0) {
      throw new Error(
        `Unsupported Wrangler build keys for celld in ${sourceName}: ${unsupportedBuildKeys.join(", ")}. Only build.command is supported.`,
      );
    }
    buildCommand = build.command;
    delete normalized.build;
    warnings.push("Running Wrangler build.command before starting celld.");
  }
  if (Object.hasOwn(normalized, "assets")) {
    if (!isRecord(normalized.assets)) {
      throw new Error(`Wrangler config ${sourceName} has an invalid assets config; expected an object.`);
    }
    if (!Object.hasOwn(normalized.assets, "directory")) {
      requiresAssetsDirectory = true;
    } else if (typeof normalized.assets.directory !== "string" || !normalized.assets.directory.trim()) {
      throw new Error(`Wrangler config ${sourceName} has an invalid assets.directory; expected a non-empty path.`);
    }
  }

  return {
    config: normalized,
    warnings,
    buildCommand,
    requiresAssetsDirectory,
    changed: warnings.length > 0 || requiresAssetsDirectory,
  };
}

async function hasCloudflareVitePlugin(projectDirectory) {
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(join(projectDirectory, "package.json"), "utf8"));
  } catch {
    return false;
  }
  if (!isRecord(packageJson)) return false;
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.optionalDependencies,
  };
  if (!Object.hasOwn(dependencies, "@cloudflare/vite-plugin")) return false;

  for (const name of [
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.cjs",
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.cts",
  ]) {
    try {
      if ((await stat(join(projectDirectory, name))).isFile()) return true;
    } catch {
      // Try the next supported Vite config extension.
    }
  }
  return false;
}

async function discoverViteAssetsDirectory(projectDirectory, configPath) {
  const candidates = [];

  const distDirectory = join(projectDirectory, "dist");
  await addAssetRootIfPresent(distDirectory, candidates);
  let distEntries = [];
  try {
    distEntries = await readdir(distDirectory, { withFileTypes: true });
  } catch {
    // The project may emit assets only through the Cloudflare Build Output format.
  }
  for (const entry of distEntries) {
    if (entry.isDirectory()) {
      await addAssetRootIfPresent(join(distDirectory, entry.name), candidates);
    }
  }

  const workersDirectory = join(projectDirectory, ".cloudflare", "output", "v0", "workers");
  let workerEntries = [];
  try {
    workerEntries = await readdir(workersDirectory, { withFileTypes: true });
  } catch {
    // No Cloudflare Build Output was generated.
  }
  for (const entry of workerEntries) {
    if (!entry.isDirectory()) continue;
    await addAssetRootIfPresent(join(workersDirectory, entry.name, "assets"), candidates);
  }

  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length !== 1) {
    const reason = uniqueCandidates.length === 0
      ? "no index.html was found in the Cloudflare Build Output assets or conventional dist directories"
      : `multiple asset roots were found: ${uniqueCandidates.map((path) => relative(projectDirectory, path)).join(", ")}`;
    throw new Error(
      `Could not safely infer assets.directory for ${configPath}: ${reason}. Set assets.directory explicitly in your Wrangler config.`,
    );
  }
  return relative(projectDirectory, uniqueCandidates[0]);
}

async function addAssetRootIfPresent(candidate, candidates) {
  try {
    if ((await stat(join(candidate, "index.html"))).isFile()) candidates.push(candidate);
  } catch {
    // This candidate is not an emitted SPA asset directory.
  }
}

async function findConfig(projectDirectory) {
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const candidate = join(projectDirectory, name);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next conventional Wrangler config filename.
    }
  }
  return undefined;
}

function passthrough(args) {
  return { args: [...args], warnings: [], cleanup: async () => {} };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

import { randomUUID } from "node:crypto";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

export async function prepareWranglerProject(args, { cwd = process.cwd() } = {}) {
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
  const result = {
    args: [...args],
    warnings: normalized.warnings,
    buildCommand: normalized.buildCommand,
    buildDirectory: dirname(configPath),
    cleanup: async () => {},
  };

  if (!normalized.changed) return result;

  const temporaryPath = join(
    dirname(configPath),
    `.sobjects-wrangler-${process.pid}-${randomUUID()}.json`,
  );
  await writeFile(temporaryPath, `${JSON.stringify(normalized.config, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  if (args[0] && !args[0].startsWith("-")) {
    result.args[0] = temporaryPath;
  } else {
    result.args.unshift(temporaryPath);
  }
  result.cleanup = async () => unlink(temporaryPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
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
    if (!isRecord(normalized.assets) || typeof normalized.assets.directory !== "string" || !normalized.assets.directory.trim()) {
      throw new Error(
        `Wrangler config ${sourceName} sets assets without assets.directory. celld needs a built asset directory; Vite-generated asset bindings are not supported automatically yet.`,
      );
    }
  }

  return {
    config: normalized,
    warnings,
    buildCommand,
    changed: warnings.length > 0,
  };
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

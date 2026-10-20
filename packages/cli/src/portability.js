// `sobjects build`: bundles a project the way the native engine does and checks
// that every Node.js built-in it imports works on Cloudflare Workers, so an
// app is either portable (it runs on Cloudflare, celld and the native engine)
// or native-only. The module lists follow
// https://developers.cloudflare.com/workers/runtime-apis/nodejs/ (Aug 2026).
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";

// Supported or partially supported with nodejs_compat.
const SUPPORTED = new Set([
  "assert", "async_hooks", "buffer", "console", "crypto", "diagnostics_channel", "dns", "events", "fs", "http", "https",
  "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring", "stream", "string_decoder", "test",
  "timers", "tls", "url", "util", "zlib",
]);
// Importable on Cloudflare, but the implementation is a non-functional stub.
const STUBS = new Set([
  "_stream_wrap", "child_process", "cluster", "dgram", "domain", "http2", "inspector", "readline", "repl", "sqlite",
  "trace_events", "tty", "v8", "vm", "wasi", "worker_threads",
]);
// node:fs is on by default from this compatibility date (earlier: enable_nodejs_fs_module).
const FS_DEFAULT_DATE = "2025-09-01";
// nodejs_compat is on by default from this compatibility date.
const NODEJS_COMPAT_DEFAULT_DATE = "2026-08-04";
// Older Node versions omit prefix-only modules such as node:sqlite from
// builtinModules, so the documented lists count as built-ins too.
const BUILTINS = new Set([...builtinModules.map((name) => name.replace(/^node:/, "")), ...SUPPORTED, ...STUBS]);
const BUILTIN_RE = /^(node:)?([a-z_]+)(\/[a-z_/]+)?$/;

export function classifyImport(specifier, config) {
  const match = BUILTIN_RE.exec(specifier);
  const base = match?.[2];
  if (!match || (!BUILTINS.has(base) && !BUILTINS.has(`${base}${match[3] ?? ""}`))) return null;
  const flags = config.compatibility_flags ?? [];
  const date = config.compatibility_date ?? "";
  const nodejsCompat = flags.includes("nodejs_compat") || flags.includes("nodejs_compat_v2") || date >= NODEJS_COMPAT_DEFAULT_DATE;
  if (STUBS.has(base)) return { portable: false, reason: `node:${base} is a non-functional stub on Cloudflare Workers` };
  if (!SUPPORTED.has(base)) return { portable: false, reason: `node:${base} is not available on Cloudflare Workers` };
  if (!nodejsCompat) return { portable: false, reason: `node:${base} needs the nodejs_compat compatibility flag` };
  if (base === "fs" && date < FS_DEFAULT_DATE && !flags.includes("enable_nodejs_fs_module")) {
    return { portable: false, reason: `node:fs needs compatibility_date ${FS_DEFAULT_DATE} or later, or enable_nodejs_fs_module` };
  }
  return { portable: true };
}

// Bundles the Worker and returns the Node.js built-ins it imports, grouped
// by module, with the files that import them.
export async function analyzeProject(config) {
  const { build } = await import("esbuild");
  const imports = new Map();
  const packageRoots = new Map();
  // esbuild reports real paths (e.g. /private/var on macOS for /var).
  const root = realpathSync(config.directory);
  const record = {
    name: "sobjects-portability",
    setup(builder) {
      builder.onResolve({ filter: /^(node:|cloudflare:)?[a-z_]+(\/[a-z_/]+)?$/ }, (args) => {
        const isCloudflare = args.path.startsWith("cloudflare:");
        if (!isCloudflare && !classifyImport(args.path, config)) return undefined;
        const key = args.path.replace(/^node:/, "");
        if (!imports.has(key)) imports.set(key, { specifier: args.path, importers: new Set() });
        imports.get(key).importers.add(relative(root, args.importer) || args.importer);
        return { path: args.path, external: true };
      });
      // Remember which packages the bundle pulls in, to check them for native addons.
      builder.onLoad({ filter: /node_modules/ }, (args) => {
        const packageRoot = findPackageRoot(args.path);
        if (packageRoot && !packageRoots.has(packageRoot)) packageRoots.set(packageRoot, relative(root, args.path));
        return undefined;
      });
    },
  };
  await build({
    entryPoints: [resolve(root, config.main)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    conditions: ["workerd", "worker"],
    logLevel: "silent",
    plugins: [record],
  });
  const findings = [];
  for (const [module, { specifier, importers }] of [...imports].sort(([a], [b]) => a.localeCompare(b))) {
    if (specifier.startsWith("cloudflare:")) {
      findings.push({ module: specifier, portable: true, importers: [...importers].sort() });
      continue;
    }
    const verdict = classifyImport(specifier, config);
    findings.push({ module: `node:${module}`, ...verdict, importers: [...importers].sort() });
  }
  for (const [packageRoot, importer] of packageRoots) {
    if (!hasNativeAddon(packageRoot)) continue;
    findings.push({
      module: relative(root, packageRoot).split(sep).join("/"),
      portable: false,
      reason: "this package ships a compiled Node.js addon, which Cloudflare Workers cannot load",
      importers: [importer],
    });
  }
  return { portable: findings.every((finding) => finding.portable), findings };
}

// The package directory under the last node_modules (scoped packages included).
function findPackageRoot(file) {
  const parts = file.split(sep);
  const index = parts.lastIndexOf("node_modules");
  if (index === -1 || !parts[index + 1]) return null;
  return parts.slice(0, parts[index + 1].startsWith("@") ? index + 3 : index + 2).join(sep);
}

function hasNativeAddon(packageRoot) {
  if (existsSync(join(packageRoot, "binding.gyp"))) return true;
  return ["build", "prebuilds"].some((folder) => containsNodeFile(join(packageRoot, folder), 3));
}

function containsNodeFile(directory, depth) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => (entry.isFile() && entry.name.endsWith(".node")) || (entry.isDirectory() && depth > 0 && containsNodeFile(join(directory, entry.name), depth - 1)));
}

export function formatReport({ portable, findings }) {
  const lines = [];
  for (const finding of findings) {
    const where = finding.importers.slice(0, 3).join(", ") + (finding.importers.length > 3 ? `, +${finding.importers.length - 3} more` : "");
    lines.push(`${finding.portable ? "ok  " : "FAIL"} ${finding.module}${finding.reason ? `: ${finding.reason}` : ""} (${where})`);
  }
  lines.push(portable
    ? "Portable: every Node.js built-in this app imports works on Cloudflare Workers."
    : "Native-only: this app uses Node.js built-ins or native addons that do not work on Cloudflare Workers. It runs on the native engine.");
  return lines.join("\n");
}

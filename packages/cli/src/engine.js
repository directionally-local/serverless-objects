import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

export const CELLD_VERSION = "0.6.2";

// Every installable version is pinned here with the SHA-256 of each release
// asset, so an upgrade or rollback can never fetch an unverified binary.
export const CELLD_RELEASES = Object.freeze({
  "0.6.2": Object.freeze({
    "darwin-arm64": {
      filename: "celld-aarch64-apple-darwin.gz",
      sha256: "b81a38299800679e9651fd7c1544540185682dcb59eed1a24c8cc36c6b31e76d",
    },
    "linux-arm64": {
      filename: "celld-aarch64-unknown-linux-gnu.gz",
      sha256: "4eca87c6797590000a344c1b768364e9696e8817f5fbc16193f459d2edac7cd0",
    },
    "linux-x64": {
      filename: "celld-x86_64-unknown-linux-gnu.gz",
      sha256: "ce0ee3552cc8d55dde3998dc3b1b0c8f547bbcb4bc803d2a94842368b047646c",
    },
  }),
  "0.6.1": Object.freeze({
    "darwin-arm64": {
      filename: "celld-aarch64-apple-darwin.gz",
      sha256: "3033cc4f428433f4239ac616a04092cd4b6c7db19f2f5ba9926c86ec56c34c95",
    },
    "linux-arm64": {
      filename: "celld-aarch64-unknown-linux-gnu.gz",
      sha256: "ab99053bcced225bb5b54f428792260c905b782b8a61947362a12ce3a9c22def",
    },
    "linux-x64": {
      filename: "celld-x86_64-unknown-linux-gnu.gz",
      sha256: "79a8253cff5d4e8a4a9f7a2611e393390f7fe9025f00e88467875b007c44866b",
    },
  }),
});

export const CELLD_ASSETS = CELLD_RELEASES[CELLD_VERSION];
const SELECTION_FILE = "celld.json";

export function defaultDataDirectory(env = process.env) {
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return env.SOBJECTS_DATA_DIR || join(base, "serverless-objects");
}

export async function installCelld({
  version = CELLD_VERSION,
  dataDirectory = defaultDataDirectory(),
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  releases = CELLD_RELEASES,
  assets = releases[version],
} = {}) {
  if (!assets) {
    throw new Error(
      `celld ${version} is not a pinned release. Known versions: ${Object.keys(releases).join(", ")}.`,
    );
  }
  const platformKey = `${platform}-${arch}`;
  const asset = assets[platformKey];
  if (!asset) {
    throw new Error(
      `celld ${version} has no release binary for ${platform}-${arch}. Supported targets: macOS arm64, Linux arm64, and Linux x64.`,
    );
  }

  const executable = celldExecutablePath(dataDirectory, version);
  const installDirectory = dirname(executable);
  const checksumFile = `${executable}.sha256`;
  if (await hasValidCachedBinary(executable, checksumFile)) return executable;

  const url = `https://github.com/denoland/celld/releases/download/v${version}/${asset.filename}`;
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new Error(`Could not download celld ${version}: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`Could not download celld ${version}: HTTP ${response.status}`);
  }

  const compressed = Buffer.from(await response.arrayBuffer());
  const compressedSha256 = sha256(compressed);
  if (compressedSha256 !== asset.sha256) {
    throw new Error(
      `celld ${version} checksum mismatch for ${asset.filename}; refusing to install it.`,
    );
  }

  let binary;
  try {
    binary = gunzipSync(compressed);
  } catch (error) {
    throw new Error(`Could not unpack celld ${version}: ${error.message}`);
  }
  if (binary.length === 0) throw new Error(`celld ${version} release binary was empty.`);

  await mkdir(installDirectory, { recursive: true });
  const suffix = randomUUID();
  const temporaryBinary = `${executable}.tmp-${suffix}`;
  const temporaryChecksum = `${checksumFile}.tmp-${suffix}`;
  const binarySha256 = sha256(binary);
  try {
    await writeFile(temporaryBinary, binary, { mode: 0o755 });
    await chmod(temporaryBinary, 0o755);
    await writeFile(temporaryChecksum, `${binarySha256}\n`, { mode: 0o600 });
    await rename(temporaryBinary, executable);
    await rename(temporaryChecksum, checksumFile);
  } catch (error) {
    await unlink(temporaryBinary).catch(() => {});
    await unlink(temporaryChecksum).catch(() => {});
    throw new Error(`Could not install celld at ${installDirectory}: ${error.message}`);
  }
  return executable;
}

export function celldExecutablePath(dataDirectory, version) {
  return join(dataDirectory, "engines", `celld-${version}`, "celld");
}

export async function isCelldInstalled(dataDirectory, version) {
  const executable = celldExecutablePath(dataDirectory, version);
  return hasValidCachedBinary(executable, `${executable}.sha256`);
}

// The selected engine version lives beside the installs. Without a selection
// the CLI's pinned version is used, so upgrading the CLI upgrades celld.
export async function readEngineSelection(dataDirectory) {
  const path = join(dataDirectory, "engines", SELECTION_FILE);
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`Could not read engine selection ${path}: ${error.message}`);
  }
  if (typeof value?.version !== "string") throw new Error(`Invalid engine selection ${path}.`);
  return value;
}

export async function writeEngineSelection(dataDirectory, selection) {
  const directory = join(dataDirectory, "engines");
  await mkdir(directory, { recursive: true });
  const path = join(directory, SELECTION_FILE);
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(selection, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw new Error(`Could not write engine selection ${path}: ${error.message}`);
  }
}

async function hasValidCachedBinary(executable, checksumFile) {
  try {
    await access(executable);
    const [binary, expected] = await Promise.all([
      readFile(executable),
      readFile(checksumFile, "utf8"),
    ]);
    return sha256(binary) === expected.trim();
  } catch {
    return false;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

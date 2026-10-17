import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export const CELLD_VERSION = "0.6.2";

export const CELLD_ASSETS = Object.freeze({
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
});

export function defaultDataDirectory(env = process.env) {
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return env.SOBJECTS_DATA_DIR || join(base, "serverless-objects");
}

export async function installCelld({
  dataDirectory = defaultDataDirectory(),
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  assets = CELLD_ASSETS,
} = {}) {
  const platformKey = `${platform}-${arch}`;
  const asset = assets[platformKey];
  if (!asset) {
    throw new Error(
      `celld ${CELLD_VERSION} has no release binary for ${platform}-${arch}. Supported targets: macOS arm64, Linux arm64, and Linux x64.`,
    );
  }

  const installDirectory = join(dataDirectory, "engines", `celld-${CELLD_VERSION}`);
  const executable = join(installDirectory, "celld");
  const checksumFile = `${executable}.sha256`;
  if (await hasValidCachedBinary(executable, checksumFile)) return executable;

  const url = `https://github.com/denoland/celld/releases/download/v${CELLD_VERSION}/${asset.filename}`;
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new Error(`Could not download celld ${CELLD_VERSION}: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`Could not download celld ${CELLD_VERSION}: HTTP ${response.status}`);
  }

  const compressed = Buffer.from(await response.arrayBuffer());
  const compressedSha256 = sha256(compressed);
  if (compressedSha256 !== asset.sha256) {
    throw new Error(
      `celld ${CELLD_VERSION} checksum mismatch for ${asset.filename}; refusing to install it.`,
    );
  }

  let binary;
  try {
    binary = gunzipSync(compressed);
  } catch (error) {
    throw new Error(`Could not unpack celld ${CELLD_VERSION}: ${error.message}`);
  }
  if (binary.length === 0) throw new Error(`celld ${CELLD_VERSION} release binary was empty.`);

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

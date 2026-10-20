// Publishes the packages a Release Please run released, or the package named
// by a manually dispatched release tag. Run from the repository root at the
// release commit. A version already on npm is skipped. A package that does not
// exist on npm yet is skipped with instructions: npm trusted publishing only
// works for existing packages, so its first version is published by hand.
//
//   RELEASE_OUTPUTS='<release-please outputs JSON>' node .github/scripts/publish.mjs
//   DISPATCH_TAG=hotcell-v0.1.0 node .github/scripts/publish.mjs
//   add --dry-run to print the plan without publishing
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");
const config = JSON.parse(readFileSync("release-please-config.json", "utf8"));

// Release tags are <component>-v<version>; component defaults to the package name.
const packages = Object.entries(config.packages).map(([path, settings]) => {
  const { name, version } = JSON.parse(readFileSync(`${path}/package.json`, "utf8"));
  return { path, name, version, component: settings.component ?? settings["package-name"] ?? name };
});

function targets() {
  if (process.env.DISPATCH_TAG) {
    const tag = process.env.DISPATCH_TAG;
    const match = packages.find((pkg) => tag.startsWith(`${pkg.component}-v`));
    if (!match) throw new Error(`Tag ${tag} does not name a package in release-please-config.json`);
    return [{ ...match, tag }];
  }
  const outputs = JSON.parse(process.env.RELEASE_OUTPUTS || "{}");
  return packages
    .filter((pkg) => String(outputs[`${pkg.path}--release_created`]) === "true")
    .map((pkg) => ({ ...pkg, tag: outputs[`${pkg.path}--tag_name`] }));
}

function onNpm(spec) {
  try {
    execFileSync("npm", ["view", spec, "version"], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

let failed = false;
for (const pkg of targets()) {
  if (pkg.tag !== `${pkg.component}-v${pkg.version}`) {
    console.error(`::error::${pkg.tag} does not match ${pkg.path}/package.json version ${pkg.version}`);
    failed = true;
    continue;
  }
  if (onNpm(`${pkg.name}@${pkg.version}`)) {
    console.log(`${pkg.name}@${pkg.version} is already published`);
    continue;
  }
  if (!onNpm(pkg.name)) {
    console.log(`::notice::${pkg.name} is not on npm yet. Publish ${pkg.tag} by hand once, then add a trusted publisher for release-please.yml: git checkout ${pkg.tag} && npm ci && npm publish --workspace=${pkg.path}`);
    continue;
  }
  console.log(`Publishing ${pkg.name}@${pkg.version} from ${pkg.path}`);
  if (!dryRun) execFileSync("npm", ["publish", `--workspace=${pkg.path}`, "--provenance", "--access", "public"], { stdio: "inherit" });
}
if (failed) process.exitCode = 1;

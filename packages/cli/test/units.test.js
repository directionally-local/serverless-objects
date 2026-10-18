import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { renderLaunchdPlist, renderSystemdUnit, unitTarget, writeUnit } from "../src/units.js";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const base = {
  nodeExecutable: "/usr/bin/node",
  cliScript: "/opt/sobjects/bin/sobjects.mjs",
  configPath: "/srv/my app/sobjects.toml",
};

test("renders a user systemd unit that runs up in the foreground", () => {
  const unit = renderSystemdUnit({ ...base, env: { SOBJECTS_STATE_DIR: "/var/lib/so" } });
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/sobjects\/bin\/sobjects\.mjs up --config "\/srv\/my app\/sobjects\.toml"$/m);
  assert.match(unit, /^WorkingDirectory="\/srv\/my app"$/m);
  assert.match(unit, /^EnvironmentFile=-"\/srv\/my app\/sobjects\.env"$/m);
  assert.match(unit, /^Environment=SOBJECTS_STATE_DIR=\/var\/lib\/so$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(unit, /User=|CAP_NET_BIND_SERVICE/);
});

test("renders a system unit with a service account and low-port capability", () => {
  const unit = renderSystemdUnit({ ...base, system: true, user: "sobjects" });
  assert.match(unit, /^User=sobjects$/m);
  assert.match(unit, /^AmbientCapabilities=CAP_NET_BIND_SERVICE$/m);
  assert.match(unit, /^WantedBy=multi-user\.target$/m);
  assert.match(unit, /^StateDirectory=serverless-objects$/m);
  assert.throws(() => renderSystemdUnit({ ...base, system: true }), /needs --user/);
  assert.throws(() => renderSystemdUnit({ ...base, configPath: "/a\nb/sobjects.toml" }), /newlines/);
});

test("escapes systemd specifiers", () => {
  const unit = renderSystemdUnit({ ...base, configPath: "/srv/100%/sobjects.toml" });
  assert.match(unit, /--config \/srv\/100%%\/sobjects\.toml/);
});

test("renders a launchd agent with escaped arguments and environment", () => {
  const plist = renderLaunchdPlist({
    ...base,
    configPath: "/Users/a&b/sobjects.toml",
    logDirectory: "/Users/a/state",
    env: { SOBJECTS_DATA_DIR: "/Users/a/data" },
  });
  assert.match(plist, /<string>dev\.serverless-objects<\/string>/);
  assert.match(plist, /<string>\/Users\/a&amp;b\/sobjects\.toml<\/string>/);
  assert.match(plist, /<key>SOBJECTS_DATA_DIR<\/key>\n\s+<string>\/Users\/a\/data<\/string>/);
  assert.match(plist, /<string>\/Users\/a\/state\/service\.log<\/string>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\n\s+<false\/>/);
});

test("chooses unit paths and enable commands", () => {
  assert.equal(
    unitTarget({ kind: "systemd", home: "/home/a", env: {} }).path,
    "/home/a/.config/systemd/user/serverless-objects.service",
  );
  assert.equal(
    unitTarget({ kind: "systemd", home: "/home/a", env: { XDG_CONFIG_HOME: "/cfg" } }).path,
    "/cfg/systemd/user/serverless-objects.service",
  );
  assert.equal(unitTarget({ kind: "systemd", system: true }).path, "/etc/systemd/system/serverless-objects.service");
  assert.equal(
    unitTarget({ kind: "launchd", home: "/Users/a" }).path,
    "/Users/a/Library/LaunchAgents/dev.serverless-objects.plist",
  );
  assert.throws(() => unitTarget({ kind: "launchd", system: true }), /per user/);
});

test("refuses to overwrite a unit without force", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-units-"));
  directories.push(directory);
  const path = join(directory, "nested", "unit.service");
  await writeUnit(path, "one");
  await assert.rejects(writeUnit(path, "two"), /already exists; pass --force/);
  await writeUnit(path, "three", { force: true });
  assert.equal(await readFile(path, "utf8"), "three");
});

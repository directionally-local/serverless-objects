import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SERVICE_LABEL = "dev.serverless-objects";
export const SYSTEMD_UNIT = "serverless-objects.service";

// Units run `sobjects up` in the foreground so the service manager owns the
// process tree: the ingress runs in-process and celld is its child.
export function renderSystemdUnit({ nodeExecutable, cliScript, configPath, system = false, user, env = {} }) {
  if (system && !user) throw new Error("A system unit needs --user to name the account that runs celld.");
  const lines = [
    "[Unit]",
    "Description=Serverless Objects (celld and ingress)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
  ];
  if (system) lines.push(`User=${user}`);
  lines.push(
    `WorkingDirectory=${systemdEscape(dirname(configPath))}`,
    `ExecStart=${[nodeExecutable, cliScript, "up", "--config", configPath].map(systemdEscape).join(" ")}`,
    // Object-store credentials belong here, not in sobjects.toml.
    `EnvironmentFile=-${systemdEscape(join(dirname(configPath), "sobjects.env"))}`,
  );
  for (const [name, value] of Object.entries(env)) lines.push(`Environment=${systemdEscape(`${name}=${value}`)}`);
  // KillMode=mixed signals only `sobjects up`, which forwards SIGTERM to celld
  // and exits 143 once celld has stopped.
  lines.push(
    "Restart=on-failure",
    "RestartSec=2",
    "KillMode=mixed",
    "TimeoutStopSec=30",
    "SuccessExitStatus=143",
    "NoNewPrivileges=true",
  );
  if (system) {
    // Lets the ingress bind :443 and :80 without running as root.
    lines.push(
      "StateDirectory=serverless-objects",
      "StateDirectoryMode=0700",
      "AmbientCapabilities=CAP_NET_BIND_SERVICE",
      "CapabilityBoundingSet=CAP_NET_BIND_SERVICE",
      "ProtectSystem=full",
      "PrivateTmp=true",
    );
  }
  lines.push("", "[Install]", `WantedBy=${system ? "multi-user.target" : "default.target"}`, "");
  return lines.join("\n");
}

export function renderLaunchdPlist({ nodeExecutable, cliScript, configPath, logDirectory, env = {} }) {
  const argumentsXml = [nodeExecutable, cliScript, "up", "--config", configPath]
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const envEntries = Object.entries(env);
  const envXml = envEntries.length === 0
    ? ""
    : `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries
      .map(([name, value]) => `    <key>${xmlEscape(name)}</key>\n    <string>${xmlEscape(value)}</string>`)
      .join("\n")}\n  </dict>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(dirname(configPath))}</string>
${envXml}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logDirectory, "service.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logDirectory, "service.log"))}</string>
</dict>
</plist>
`;
}

export function unitTarget({ kind, system = false, home = homedir(), env = process.env }) {
  if (kind === "launchd") {
    if (system) throw new Error("launchd units are installed per user; omit --system.");
    return {
      path: join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
      next: [`launchctl bootstrap gui/$(id -u) ${join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`)}`],
    };
  }
  if (system) {
    return {
      path: join("/etc/systemd/system", SYSTEMD_UNIT),
      next: ["sudo systemctl daemon-reload", `sudo systemctl enable --now ${SYSTEMD_UNIT}`],
    };
  }
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  return {
    path: join(configHome, "systemd", "user", SYSTEMD_UNIT),
    next: [
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${SYSTEMD_UNIT}`,
      "loginctl enable-linger \"$USER\"  # keep it running after logout",
    ],
  };
}

export async function writeUnit(path, contents, { force = false } = {}) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, contents, { flag: force ? "w" : "wx", mode: 0o644 });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`${path} already exists; pass --force to replace it.`);
    }
    throw new Error(`Could not write ${path}: ${error.message}`);
  }
}

function systemdEscape(value) {
  const text = String(value);
  if (/[\n\r]/.test(text)) throw new Error("Service unit values cannot contain newlines.");
  const escaped = text.replace(/%/g, "%%");
  return /[\s"'\\]/.test(escaped) ? `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : escaped;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

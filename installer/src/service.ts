/*============================= services ===================================*/
// systemd units (default) and pm2 for both apps. The daemon service is always
// installed STOPPED: the user edits /etc/daemon/.env first (PRODUCT decision).

import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ServiceMgr } from "./plan"
import { pushLog } from "./log"
import { nodeBinDir, npmPriv, privCmd, privEnv, run, whichPath } from "./run"

export type App = "panel" | "daemon"

export const PANEL_UNIT = "airlink-panel.service"
export const DAEMON_UNIT = "airlink-daemon.service"

const unitDir = () => process.env.AIRLINK_UNIT_DIR || "/etc/systemd/system"

export function unitPath(app: App): string {
  return join(unitDir(), app === "panel" ? PANEL_UNIT : DAEMON_UNIT)
}

export function appName(app: App): string {
  return `airlink-${app}`
}

function unitContent(app: App, appDir: string, npmPath: string, nodeDir: string): string {
  const desc = app === "panel" ? "Airlink Panel" : "Airlink Daemon"
  const after = app === "panel" ? "network.target" : "network.target docker.service"
  return `[Unit]
Description=${desc}
After=${after}

[Service]
Type=simple
User=root
WorkingDirectory=${appDir}
Environment="PATH=${nodeDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=${npmPath} run start
Restart=always

[Install]
WantedBy=multi-user.target
`
}

async function writeUnit(app: App, content: string): Promise<void> {
  const tmp = join(tmpdir(), `airlink-${app}.service`)
  await writeFile(tmp, content)
  if ((await run(privCmd(["install", "-m", "644", tmp, unitPath(app)]))) !== 0) {
    throw new Error(`failed to write ${unitPath(app)} - check permissions (is ${unitDir()} present?)`)
  }
}

export async function installService(app: App, mgr: ServiceMgr, appDir: string): Promise<string> {
  if (mgr === "systemd") {
    const npmPath = await whichPath("npm")
    if (!npmPath) throw new Error("npm not found - install node (>= 18) and re-run")
    const nodeDir = await nodeBinDir()
    await writeUnit(app, unitContent(app, appDir, npmPath, nodeDir))
    if ((await run(privCmd(["systemctl", "daemon-reload"]))) !== 0) {
      throw new Error("systemctl daemon-reload failed - is systemd the init system? (use --service pm2 otherwise)")
    }
    if (app === "panel") {
      if ((await run(privCmd(["systemctl", "enable", "--now", PANEL_UNIT]))) !== 0) {
        throw new Error(`systemctl enable --now failed - check: journalctl -u ${PANEL_UNIT}`)
      }
      return "systemd"
    }
    // daemon: unit written, deliberately NOT started - the user edits .env first
    return "systemd (stopped)"
  }

  if (mgr === "pm2") {
    if (!(await whichPath("pm2"))) {
      pushLog("pm2 not found - installing globally")
      if ((await npmPriv(["install", "-g", "pm2"])) !== 0) throw new Error("npm install -g pm2 failed - see logs above")
      if (!(await whichPath("pm2"))) {
        throw new Error("pm2 still not found after install - add npm's global bin dir to PATH and re-run")
      }
    }
    const name = appName(app)
    const js = join(appDir, "dist", "app.js")
    if ((await privEnv(["pm2", "start", js, "--name", name, "--cwd", appDir])) !== 0) {
      throw new Error(`pm2 start ${name} failed - see logs above`)
    }
    if (app === "panel") {
      await privEnv(["pm2", "save", "--force"])
      return "pm2"
    }
    // daemon stays stopped, matching the systemd behavior
    await privEnv(["pm2", "stop", name])
    await privEnv(["pm2", "save", "--force"])
    const nodeDir = await nodeBinDir()
    if ((await privEnv(["pm2", "startup", "systemd", "-u", "root", "--hp", "/root"])) !== 0) {
      pushLog(`pm2 startup needs a manual run: sudo env PATH=${nodeDir}:$PATH pm2 startup systemd -u root --hp /root`)
    }
    return "pm2 (stopped)"
  }
  throw new Error(`unknown service manager: ${mgr}`)
}

/** stop + disable + remove the unit (or delete the pm2 app); tolerant of
 *  half-installed states - uninstall must work on what is actually there */
export async function removeService(app: App): Promise<string> {
  const name = appName(app)
  if (existsSync(unitPath(app))) {
    await run(privCmd(["systemctl", "disable", "--now", `${name}.service`])) // tolerant by design
    if ((await run(privCmd(["rm", "-f", unitPath(app)]))) !== 0) {
      throw new Error(`failed to remove ${unitPath(app)} - check permissions`)
    }
    await run(privCmd(["systemctl", "daemon-reload"]))
    return "systemd unit removed"
  }
  if (await whichPath("pm2")) {
    if ((await privEnv(["pm2", "describe", name])) === 0) {
      await privEnv(["pm2", "delete", name])
      await privEnv(["pm2", "save", "--force"])
      return "pm2 app removed"
    }
  }
  return "no service found"
}

export async function serviceInstalled(app: App): Promise<"systemd" | "pm2" | "none"> {
  if (existsSync(unitPath(app))) return "systemd"
  if ((await whichPath("pm2")) && (await privEnv(["pm2", "describe", appName(app)])) === 0) return "pm2"
  return "none"
}

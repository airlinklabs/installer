/*============================= plan =======================================*/
// Types + step assembly + summary. Step notes carry machine-readable facts
// the summary reads (tag, fresh/preserved, service manager, health).

import { pushLog } from "./log"
import { privCmd, run } from "./run"
import { detectSystem, ensureDocker, ensureRuntimeDeps, ensureWwwData, sys } from "./sys"
import { firstIp, panelInstallSteps, panelUninstallSteps } from "./panel"
import { daemonInstallSteps, daemonUninstallSteps } from "./daemon"
import { unitPath } from "./service"

export type StepState = "pending" | "running" | "done" | "failed" | "skipped"
export type StepResult = { note?: string; skip?: boolean } | void
export type Step = { name: string; state: StepState; note?: string; run: () => Promise<StepResult> }

export type AppAction =
  | "install-both"
  | "install-panel"
  | "install-daemon"
  | "uninstall-panel"
  | "uninstall-daemon"
  | "uninstall-all"
export type ServiceMgr = "systemd" | "pm2"
export type Cfg = { action: AppAction; service: ServiceMgr; yes: boolean; demo: boolean }

export const ACTION_TITLES: Record<AppAction, string> = {
  "install-both": "install both",
  "install-panel": "install panel",
  "install-daemon": "install daemon",
  "uninstall-panel": "uninstall panel",
  "uninstall-daemon": "uninstall daemon",
  "uninstall-all": "uninstall everything",
}

/* --- shared steps (run once per plan) ------------------------------------- */

function detectStep(): Step {
  return {
    name: "detect system",
    state: "pending",
    run: async () => {
      await detectSystem()
      if (sys.family === "unknown") {
        throw new Error(`unsupported distro (ID=${sys.id || "?"}) - Debian/Ubuntu, RHEL/Fedora, Arch and openSUSE are supported`)
      }
      // the TUI only ever uses a credential that is already there (sudo -n);
      // the shipped binary runs as root and passes this immediately
      if ((await run(privCmd(["true"]))) !== 0) {
        throw new Error("sudo credential missing - run via installer.sh (which does sudo -v) or run `sudo -v` first")
      }
      await ensureWwwData()
      return { note: `${sys.id} ${sys.family}` }
    },
  }
}

function depsStep(): Step {
  return {
    name: "runtime deps",
    state: "pending",
    run: async () => {
      await ensureRuntimeDeps()
      return { note: "node, curl, unzip" }
    },
  }
}

function dockerStep(): Step {
  return {
    name: "docker",
    state: "pending",
    run: async () => {
      await ensureDocker()
      return { note: "docker ok" }
    },
  }
}

/** duplicated names collapse (keep first) - install-both shares detect/deps */
function dedup(steps: Step[]): Step[] {
  const seen = new Set<string>()
  return steps.filter((s) => {
    if (seen.has(s.name)) return false
    seen.add(s.name)
    return true
  })
}

export function buildPlan(cfg: Cfg): Step[] {
  const shared: Step[] = [detectStep(), depsStep()]
  switch (cfg.action) {
    case "install-panel":
      return dedup([...shared, ...panelInstallSteps(cfg)])
    case "install-daemon":
      return dedup([...shared, dockerStep(), ...daemonInstallSteps(cfg)])
    case "install-both":
      return dedup([...shared, dockerStep(), ...panelInstallSteps(cfg), ...daemonInstallSteps(cfg)])
    case "uninstall-panel":
      return panelUninstallSteps()
    case "uninstall-daemon":
      return daemonUninstallSteps()
    case "uninstall-all":
      return dedup([...daemonUninstallSteps(), ...panelUninstallSteps()])
  }
}

/** --demo: swap every step's run for a faked ticker (UI preview, no changes).
 *  Notes are realistic so the summary screen previews the real payoff copy. */
function demoNoteFor(name: string, cfg?: Cfg): string | undefined {
  const mgr = cfg?.service ?? "systemd"
  const isPanel = name.startsWith("panel")
  const dir = isPanel
    ? process.env.AIRLINK_PANEL_DIR || "/var/www/panel"
    : process.env.AIRLINK_DAEMON_DIR || "/etc/daemon"
  if (name === "detect system") {
    const id = sys.id || (process.platform === "darwin" ? "macos" : "linux")
    return `${id} ${sys.family === "unknown" ? "debian" : sys.family}`
  }
  if (name === "runtime deps") return "node, curl, unzip"
  if (name === "docker") return "docker ok"
  if (name.endsWith("resolve latest release")) return "Beta-demo"
  if (name.endsWith("download zip")) return "sha256 ok"
  if (name.endsWith("extract")) return "fresh install"
  if (name === "panel · write .env") return "fresh"
  if (name === "daemon · write .env") return "fresh (example defaults)"
  if (name.endsWith("set permissions")) return sys.family === "darwin" ? "root:wheel" : "www-data"
  if (name === "panel · database setup") return "sqlite ok"
  if (name === "daemon · build") return "dist/"
  if (name.endsWith("native addon (libs)")) return "rename_at + secure_open"
  if (name.endsWith("install service")) return isPanel ? mgr : `${mgr} (stopped)`
  if (name.endsWith("health check")) return "ok :3000"
  if (name.endsWith("stop service")) return mgr === "pm2" ? "pm2 app removed" : "systemd unit removed"
  if (name.endsWith("remove files")) return `removed ${dir}`
  return undefined // npm install / build / plain-done steps show a bare ✓
}

export async function demoize(steps: Step[], cfg?: Cfg): Promise<void> {
  for (const s of steps) {
    const fake = demoNoteFor(s.name, cfg)
    s.run = async () => {
      for (let i = 1; i <= 3; i++) {
        pushLog(`[${s.name}] working... item ${i}/3`)
        await new Promise((r) => setTimeout(r, 200))
      }
      pushLog(`[${s.name}] ok`)
      return fake === undefined ? undefined : { note: fake }
    }
  }
}

/* --- summary -------------------------------------------------------------- */

export function summaryLines(steps: Step[]): string[] {
  const out: string[] = []
  const map = new Map(steps.map((s) => [s.name, s]))
  const noteOf = (n: string): string | undefined => map.get(n)?.note
  const ran = (n: string): boolean => {
    const s = map.get(n)
    return !!s && s.state !== "pending"
  }

  // facts only from steps that actually succeeded (a failed step's note is an
  // error message - the failures block below prints those)
  const resolveDone = ["panel · resolve latest release", "daemon · resolve latest release"]
    .map((n) => map.get(n))
    .find((s) => s?.state === "done")
  if (resolveDone?.note) out.push(`latest release: ${resolveDone.note}`)

  if (ran("panel · install service")) {
    out.push(`panel dir: ${process.env.AIRLINK_PANEL_DIR || "/var/www/panel"}`)
    const envNote = noteOf("panel · write .env")
    if (envNote === "preserved") out.push("panel .env: preserved")
    else if (envNote === "fresh") out.push("panel .env: fresh (SESSION_SECRET generated)")
    const health = noteOf("panel · health check")
    const svc = noteOf("panel · install service")
    let panelUrl = ""
    const okPort = health?.match(/^ok :(\d+)$/)
    if (okPort) {
      panelUrl = `http://${firstIp()}:${okPort[1]}`
      out.push(`panel: ${panelUrl}`)
    } else if (health === "unreachable") {
      const where = svc === "pm2" ? "pm2 logs airlink-panel" : "journalctl -u airlink-panel -f"
      out.push(`panel health: not answering yet - ${where}`)
    }
    if (svc === "systemd" || svc === "pm2") {
      out.push(svc === "systemd" ? "panel service: systemctl status airlink-panel" : "panel service: pm2 logs airlink-panel")
      out.push(`register: open ${panelUrl || "the panel URL"} and sign up - the first signup becomes the admin`)
    }
  }

  if (ran("daemon · install service")) {
    out.push(`daemon dir: ${process.env.AIRLINK_DAEMON_DIR || "/etc/daemon"}`)
    const dEnvNote = noteOf("daemon · write .env")
    if (dEnvNote === "preserved") out.push("daemon .env: preserved")
    else if (dEnvNote === "fresh (example defaults)") {
      out.push("daemon .env: example defaults - edit /etc/daemon/.env (remote, key)")
    }
    const svc = noteOf("daemon · install service")
    if (svc === "systemd (stopped)") out.push("start daemon: systemctl enable --now airlink-daemon")
    else if (svc === "pm2 (stopped)") out.push("start daemon: pm2 start airlink-daemon")
    if (svc && (svc.includes("stopped") || svc === "systemd" || svc === "pm2")) {
      out.push("register node: panel -> Admin -> Nodes -> Create, paste the daemon key")
    }
  }

  // uninstall: what died, what survived
  for (const s of steps) {
    if (s.state !== "done" || !s.note) continue
    if (s.note.startsWith("removed ")) out.push(`removed: ${s.note.slice("removed ".length)}`)
    else if (s.note === "systemd unit removed" || s.note === "pm2 app removed") {
      const app = s.name.split(" · ")[0]
      out.push(`removed service: airlink-${app} (${s.note === "systemd unit removed" ? "systemd" : "pm2"})`)
    }
  }
  if (steps.some((s) => s.state === "done" && s.note?.startsWith("removed "))) {
    out.push("kept: node, docker, pm2 (remove manually if unwanted)")
  }

  for (const s of steps) if (s.state === "failed") out.push(`failed: ${s.name} - ${s.note ?? "see logs"}`)
  return out
}

/*============================= confirm copy ===============================*/
// Pure body builders for the TUI confirm box (spec §11 screen 3). Kept out of
// installer.ts so the copy is unit-tested: the uninstall body must state the
// REAL manager per app - detected before the box renders - so a pm2-managed
// app never claims unit files and an absent app says so.

export type InstalledMgr = "systemd" | "pm2" | "none"

/** install body: chosen service manager, unit/files per app, deps footer */
export function installConfirmLines(
  action: AppAction,
  service: ServiceMgr,
  dirs: { panel: string; daemon: string },
): string[] {
  const lines: string[] = []
  if (action !== "install-daemon") {
    if (service === "systemd") {
      lines.push("airlink-panel.service  enable + start")
      lines.push(`  unit   ${unitPath("panel")}`)
    } else {
      lines.push("airlink-panel (pm2)  start + pm2 save")
    }
    lines.push(`  files  ${dirs.panel}`)
  }
  if (action !== "install-panel") {
    if (lines.length) lines.push("")
    if (service === "systemd") {
      lines.push("airlink-daemon.service  enable - starts after you edit .env")
      lines.push(`  unit   ${unitPath("daemon")}`)
    } else {
      lines.push("airlink-daemon (pm2)  stopped until you edit .env")
    }
    lines.push(`  files  ${dirs.daemon}`)
  }
  lines.push("")
  lines.push("node, docker + build tools install only if missing")
  return lines
}

/** uninstall body: what dies per app under the REAL (auto-detected) manager */
export function uninstallConfirmLines(
  action: AppAction,
  mgrs: { panel: InstalledMgr; daemon: InstalledMgr },
  dirs: { panel: string; daemon: string },
): string[] {
  const lines: string[] = []
  const block = (app: "panel" | "daemon", mgr: InstalledMgr, dir: string): void => {
    if (lines.length) lines.push("")
    if (mgr === "none") {
      // no service, but rm -rf still runs (panelUninstallSteps is unconditional)
      lines.push(`airlink-${app}  (no service - files still removed)`)
      lines.push(`  files  ${dir}${app === "panel" ? "   rm -rf - the database lives inside" : "   rm -rf"}`)
    } else if (mgr === "pm2") {
      lines.push(`airlink-${app} (pm2)  pm2 delete + pm2 save`)
      lines.push(`  files  ${dir}`)
    } else {
      lines.push(`airlink-${app}.service  (stop + disable)`)
      lines.push(`  unit   ${unitPath(app)}`)
      lines.push(`  files  ${dir}${app === "panel" ? "   rm -rf - the database lives inside" : "   rm -rf"}`)
    }
  }
  if (action !== "uninstall-daemon") block("panel", mgrs.panel, dirs.panel)
  if (action !== "uninstall-panel") block("daemon", mgrs.daemon, dirs.daemon)
  lines.push("")
  lines.push("kept: node, docker, pm2")
  return lines
}

/** cancel-first select rows for the uninstall confirm; the action description
 *  must not promise service removal when no target even has a service */
export function uninstallConfirmOptions(
  action: AppAction,
  mgrs: { panel: InstalledMgr; daemon: InstalledMgr },
): { name: string; description: string }[] {
  const label = action === "uninstall-all" ? "everything" : action === "uninstall-panel" ? "panel" : "daemon"
  const targets: InstalledMgr[] = []
  if (action !== "uninstall-daemon") targets.push(mgrs.panel)
  if (action !== "uninstall-panel") targets.push(mgrs.daemon)
  const anyService = targets.some((m) => m !== "none")
  return [
    { name: "Cancel", description: "back to the menu" },
    {
      name: `Yes, remove ${label}`,
      description: anyService ? "stops services and deletes files" : "no service - removes leftover files only",
    },
  ]
}

/*============================= CLI surface ================================*/

import type { AppAction, ServiceMgr } from "./plan"

/** malformed flags are a usage problem, not a crash */
export class UsageError extends Error {}

export type Args = {
  action: AppAction | null
  service: ServiceMgr
  /** whether --service was given explicitly (decides the TUI service screen) */
  serviceGiven: boolean
  yes: boolean
  plain: boolean
  demo: boolean
  help: boolean
}

const ACTIONS: Record<string, AppAction> = {
  "--install-both": "install-both",
  "--install-panel": "install-panel",
  "--install-daemon": "install-daemon",
  "--uninstall-panel": "uninstall-panel",
  "--uninstall-daemon": "uninstall-daemon",
  "--uninstall-all": "uninstall-all",
}

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    action: null,
    service: "systemd",
    serviceGiven: false,
    yes: false,
    plain: false,
    demo: false,
    help: false,
  }
  const serviceValue = (v: string | undefined, raw: string): ServiceMgr => {
    if (v !== "systemd" && v !== "pm2") {
      throw new UsageError(`${raw} expects systemd or pm2${v === undefined ? " (missing value)" : `, got "${v}"`}`)
    }
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    const hit = ACTIONS[raw]
    if (hit) {
      a.action = hit // duplicates: last wins
      continue
    }
    if (raw === "--service") {
      a.service = serviceValue(argv[i + 1], "--service")
      a.serviceGiven = true
      i++
      continue
    }
    if (raw.startsWith("--service=")) {
      a.service = serviceValue(raw.slice("--service=".length), "--service")
      a.serviceGiven = true
      continue
    }
    switch (raw) {
      case "--yes":
        a.yes = true
        break
      case "--no-color":
        a.plain = true
        break
      case "--demo":
        a.demo = true
        break
      case "--help":
      case "-h":
        a.help = true
        break
      default:
        throw new UsageError(`unknown flag: ${raw}`)
    }
  }
  return a
}

export type Mode = { tui: boolean; notice: string | null }

/** How the run executes.
 *  - TTY + interactive intent            -> TUI (menu / confirm screens)
 *  - explicit --no-color                 -> plain, silent (the scripted contract)
 *  - action + --yes                      -> plain, silent (automation: never open
 *                                           the TUI, exit code immediately)
 *  - no usable TTY                       -> plain with a one-line stderr notice
 *    (both stdin and stdout must be TTYs; stdout redirection alone is enough to
 *    disqualify the TUI) */
export function chooseMode(
  args: Pick<Args, "plain" | "action" | "yes">,
  io: { stdinTty: boolean; stdoutTty: boolean },
): Mode {
  if (args.plain) return { tui: false, notice: null }
  if (args.action !== null && args.yes) return { tui: false, notice: null }
  if (!io.stdinTty || !io.stdoutTty) {
    return {
      tui: false,
      notice: "no TTY - falling back to plain logs (pass --no-color to skip this notice)",
    }
  }
  return { tui: true, notice: null }
}

export const USAGE = `Airlink installer - install and uninstall the panel and daemon from release zips

usage:
  installer.sh [flags]        curl -fsSL https://airlinklabs.xyz/install | bash -s -- [flags]
  bun installer.ts [flags]    (dev checkout; a TTY opens the menu, anything else runs plain)

flags:
  --install-both            install panel + daemon (latest stable releases)
  --install-panel           install the panel into /var/www/panel
  --install-daemon          install the daemon into /etc/daemon
  --uninstall-panel         remove the panel service and files
  --uninstall-daemon        remove the daemon service and files
  --uninstall-all           remove both apps (never node/docker/pm2)
  --service systemd|pm2     service manager for installs (default: systemd; skips the service screen)
  --yes                     skip the confirm screens; with an action flag this
                            is the fully scripted path (no TUI, exits on its own)
  --no-color                plain output, no TTY needed (pipes / CI)
  --demo                    fake every step - UI preview, no system changes
  --help, -h                this help (no TTY, no root)

automation:
  no TTY (pipes, CI, ssh without a pty) falls back to plain logs automatically -
  --no-color just makes that explicit. Uninstalls still require --yes.

env overrides:
  AIRLINK_PANEL_REPO / AIRLINK_DAEMON_REPO   repos to resolve (default airlinklabs/panel, airlinklabs/daemon)
  AIRLINK_PANEL_URL / AIRLINK_DAEMON_URL     direct zip URL - skips the GitHub API
  AIRLINK_PANEL_DIR / AIRLINK_DAEMON_DIR     install dirs (default /var/www/panel, /etc/daemon)
  AIRLINK_UNIT_DIR                           systemd unit dir (default /etc/systemd/system)
  AIRLINK_OS_RELEASE                         os-release path (tests/sandbox)
  AIRLINK_INSTALLER_DL                       bootstrap binary download base (installer.sh)`

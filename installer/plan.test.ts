import { afterEach, describe, expect, test } from "bun:test"
import { buildPanelEnv } from "./src/panel"
import {
  ACTION_TITLES,
  buildPlan,
  demoize,
  installConfirmLines,
  summaryLines,
  uninstallConfirmLines,
  uninstallConfirmOptions,
  type Cfg,
  type Step,
  type StepState,
} from "./src/plan"
import { unitPath } from "./src/service"

const cfg = (action: Cfg["action"], over: Partial<Cfg> = {}): Cfg => ({
  action,
  service: "systemd",
  yes: false,
  demo: false,
  ...over,
})

const PANEL_STEPS = [
  "detect system",
  "runtime deps",
  "panel · resolve latest release",
  "panel · download zip",
  "panel · extract",
  "panel · write .env",
  "panel · set permissions",
  "panel · npm install",
  "panel · database setup",
  "panel · build",
  "panel · install service",
  "panel · health check",
]

const DAEMON_STEPS = [
  "detect system",
  "runtime deps",
  "docker",
  "daemon · resolve latest release",
  "daemon · download zip",
  "daemon · extract",
  "daemon · write .env",
  "daemon · set permissions",
  "daemon · npm install",
  "daemon · build",
  "daemon · native addon (libs)",
  "daemon · install service",
]

const names = (c: Cfg) => buildPlan(c).map((s) => s.name)

describe("buildPlan", () => {
  test("install-panel step order (spec §9)", () => {
    expect(names(cfg("install-panel"))).toEqual(PANEL_STEPS)
  })

  test("install-daemon step order (spec §9)", () => {
    expect(names(cfg("install-daemon"))).toEqual(DAEMON_STEPS)
  })

  test("install-both: shared steps once, panel block before daemon, no dupes", () => {
    const n = names(cfg("install-both"))
    expect(new Set(n).size).toBe(n.length)
    expect(n[0]).toBe("detect system")
    expect(n[1]).toBe("runtime deps")
    expect(n[2]).toBe("docker")
    expect(n.indexOf("panel · health check")).toBeLessThan(n.indexOf("daemon · resolve latest release"))
    for (const p of PANEL_STEPS.slice(3)) expect(n).toContain(p)
    for (const d of DAEMON_STEPS.slice(3)) expect(n).toContain(d)
  })

  test("uninstall plans", () => {
    expect(names(cfg("uninstall-panel"))).toEqual(["panel · stop service", "panel · remove files"])
    expect(names(cfg("uninstall-daemon"))).toEqual(["daemon · stop service", "daemon · remove files"])
    expect(names(cfg("uninstall-all"))).toEqual([
      "daemon · stop service",
      "daemon · remove files",
      "panel · stop service",
      "panel · remove files",
    ])
  })

  test("all steps start pending", () => {
    for (const a of Object.keys(ACTION_TITLES) as Cfg["action"][]) {
      for (const s of buildPlan(cfg(a))) expect(s.state).toBe("pending")
    }
  })

  test("ACTION_TITLES covers every action", () => {
    expect(Object.keys(ACTION_TITLES).sort()).toEqual(
      [
        "install-both",
        "install-daemon",
        "install-panel",
        "uninstall-all",
        "uninstall-daemon",
        "uninstall-panel",
      ].sort(),
    )
  })
})

describe("buildPanelEnv", () => {
  const EXAMPLE = [
    'URL="http://localhost:3000"',
    "PORT=3000",
    'NAME="Airlink"',
    'DATABASE_URL="file:./dev.db"',
    'NODE_ENV="development"',
    'SESSION_SECRET="change_me"',
  ].join("\n")
  const SECRET = "0123456789abcdef0123456789abcdef"

  test("SESSION_SECRET replaced, other lines byte-identical", () => {
    const out = buildPanelEnv(EXAMPLE, SECRET)
    const lines = out.split("\n")
    expect(lines.length).toBe(EXAMPLE.split("\n").length)
    expect(lines[0]).toBe('URL="http://localhost:3000"')
    expect(lines[1]).toBe("PORT=3000")
    expect(lines[2]).toBe('NAME="Airlink"')
    expect(lines[3]).toBe('DATABASE_URL="file:./dev.db"')
    expect(lines[4]).toBe('NODE_ENV="development"')
    expect(lines[5]).toBe(`SESSION_SECRET="${SECRET}"`)
    expect(out).not.toContain("change_me")
  })

  test("appends SESSION_SECRET when the example has none", () => {
    const out = buildPanelEnv("PORT=4000", SECRET)
    expect(out).toBe(`PORT=4000\nSESSION_SECRET="${SECRET}"\n`)
  })
})

/* --- summary -------------------------------------------------------------- */

const mk = (name: string, state: StepState, note?: string): Step => ({ name, state, note, run: async () => {} })

const ENV_KEYS = ["AIRLINK_PANEL_DIR", "AIRLINK_DAEMON_DIR"] as const
let saved: Record<string, string | undefined> = {}
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  saved = {}
})

describe("summaryLines", () => {
  test("panel installed: tag, dir, env, url, register, service", () => {
    saved = { AIRLINK_PANEL_DIR: "/srv/panel" }
    process.env.AIRLINK_PANEL_DIR = "/srv/panel"
    const lines = summaryLines([
      mk("panel · resolve latest release", "done", "Beta-2"),
      mk("panel · write .env", "done", "fresh"),
      mk("panel · install service", "done", "systemd"),
      mk("panel · health check", "done", "ok :3000"),
    ])
    expect(lines).toContain("latest release: Beta-2")
    expect(lines).toContain("panel dir: /srv/panel")
    expect(lines).toContain("panel .env: fresh (SESSION_SECRET generated)")
    expect(lines.some((l) => l.startsWith("panel: http://") && l.endsWith(":3000"))).toBe(true)
    // exactly one colon before the port (regression: the slice bug made ::3000)
    expect(lines.some((l) => l.includes("::"))).toBe(false)
    expect(lines).toContain("panel service: systemctl status airlink-panel")
    expect(lines.some((l) => l.includes("first signup becomes the admin"))).toBe(true)
    // nothing failed, nothing uninstalled
    expect(lines.some((l) => l.startsWith("failed:"))).toBe(false)
    expect(lines.some((l) => l.startsWith("removed:"))).toBe(false)
  })

  test("preserved .env on reinstall", () => {
    const lines = summaryLines([
      mk("panel · write .env", "done", "preserved"),
      mk("panel · install service", "done", "systemd"),
      mk("panel · health check", "done", "ok :3000"),
    ])
    expect(lines).toContain("panel .env: preserved")
    expect(lines.some((l) => l === "panel .env: fresh (SESSION_SECRET generated)")).toBe(false)
  })

  test("pm2 service line", () => {
    const lines = summaryLines([mk("panel · install service", "done", "pm2"), mk("panel · health check", "done", "ok :3000")])
    expect(lines).toContain("panel service: pm2 logs airlink-panel")
  })

  test("failed health check warns but never lies", () => {
    const lines = summaryLines([
      mk("panel · install service", "done", "systemd"),
      mk("panel · health check", "done", "unreachable"),
    ])
    expect(lines).toContain("panel health: not answering yet - journalctl -u airlink-panel -f")
    expect(lines.some((l) => l.startsWith("panel: http://"))).toBe(false)
  })

  test("failed health check under pm2 points at pm2 logs, not journalctl", () => {
    const lines = summaryLines([
      mk("panel · install service", "done", "pm2"),
      mk("panel · health check", "done", "unreachable"),
    ])
    expect(lines).toContain("panel health: not answering yet - pm2 logs airlink-panel")
    expect(lines.some((l) => l.includes("journalctl"))).toBe(false)
  })

  test("daemon installed: env defaults, start command, register node", () => {
    saved = { AIRLINK_DAEMON_DIR: "/srv/daemon" }
    process.env.AIRLINK_DAEMON_DIR = "/srv/daemon"
    const lines = summaryLines([
      mk("daemon · write .env", "done", "fresh (example defaults)"),
      mk("daemon · install service", "done", "systemd (stopped)"),
    ])
    expect(lines).toContain("daemon dir: /srv/daemon")
    expect(lines).toContain("daemon .env: example defaults - edit /etc/daemon/.env (remote, key)")
    expect(lines).toContain("start daemon: systemctl enable --now airlink-daemon")
    expect(lines.some((l) => l.includes("Admin -> Nodes -> Create"))).toBe(true)
  })

  test("daemon with pm2 gets the pm2 start line", () => {
    const lines = summaryLines([
      mk("daemon · write .env", "done", "fresh (example defaults)"),
      mk("daemon · install service", "done", "pm2 (stopped)"),
    ])
    expect(lines).toContain("start daemon: pm2 start airlink-daemon")
  })

  test("uninstall summary: removed + kept", () => {
    const lines = summaryLines([
      mk("panel · stop service", "done", "systemd unit removed"),
      mk("panel · remove files", "done", "removed /var/www/panel"),
    ])
    expect(lines).toContain("removed service: airlink-panel (systemd)")
    expect(lines).toContain("removed: /var/www/panel")
    expect(lines).toContain("kept: node, docker, pm2 (remove manually if unwanted)")
  })

  test("failed steps surface as failed: lines", () => {
    const lines = summaryLines([mk("panel · npm install", "failed", "npm install failed in /var/www/panel")])
    expect(lines).toContain("failed: panel · npm install - npm install failed in /var/www/panel")
  })

  test("failed resolve never reports a release tag", () => {
    const lines = summaryLines([mk("panel · resolve latest release", "failed", "cannot resolve the latest release for airlinklabs/panel")])
    expect(lines.some((l) => l.startsWith("latest release:"))).toBe(false)
    expect(lines.some((l) => l.startsWith("failed:"))).toBe(true)
  })
})

describe("demoize", () => {
  test("fakes every step with realistic notes (summary preview copy)", async () => {
    saved = { AIRLINK_PANEL_DIR: "/tmp/airlink-demo-panel" }
    process.env.AIRLINK_PANEL_DIR = "/tmp/airlink-demo-panel"

    const c = cfg("uninstall-panel")
    const steps = buildPlan(c)
    await demoize(steps, c)
    const stop = await steps[0].run()
    expect(stop && "note" in stop && stop.note).toBe("systemd unit removed")
    const rm = await steps[1].run()
    expect(rm && "note" in rm && rm.note).toBe("removed /tmp/airlink-demo-panel")

    // run the whole fake install like the runner does (apply notes + done)
    const both = cfg("install-both", { demo: true })
    const install = buildPlan(both)
    await demoize(install, both)
    for (const s of install) {
      const res = await s.run()
      s.state = "done"
      if (res && "note" in res && res.note) s.note = res.note
    }
    const lines = summaryLines(install)
    expect(lines).toContain("latest release: Beta-demo")
    expect(lines).toContain("panel .env: fresh (SESSION_SECRET generated)")
    expect(lines).toContain("panel service: systemctl status airlink-panel")
    expect(lines).toContain("start daemon: systemctl enable --now airlink-daemon")
    expect(lines.some((l) => l.includes("Admin -> Nodes -> Create"))).toBe(true)
  }, 30_000) // 22 faked steps x 3 x 200ms ticker + the uninstall pair
})

describe("confirm box copy", () => {
  const dirs = { panel: "/var/www/panel", daemon: "/etc/daemon" }

  test("install · systemd: unit + files per app, daemon marked stopped-until-env", () => {
    const lines = installConfirmLines("install-both", "systemd", dirs)
    expect(lines).toContain("airlink-panel.service  enable + start")
    expect(lines).toContain(`  unit   ${unitPath("panel")}`)
    expect(lines.some((l) => l.includes("airlink-daemon.service") && l.includes("edit .env"))).toBe(true)
    expect(lines).toContain("  files  /var/www/panel")
    expect(lines).toContain("  files  /etc/daemon")
    expect(lines.at(-1)).toBe("node, docker + build tools install only if missing")
  })

  test("install · pm2: no unit lines, daemon copy says stopped", () => {
    const lines = installConfirmLines("install-both", "pm2", dirs)
    expect(lines.some((l) => l.includes("airlink-panel (pm2)") && l.includes("pm2 save"))).toBe(true)
    expect(lines.some((l) => l.includes("airlink-daemon (pm2)") && l.includes("stopped"))).toBe(true)
    expect(lines.some((l) => l.includes("unit"))).toBe(false)
  })

  test("install · single-app actions show only that app", () => {
    expect(installConfirmLines("install-panel", "systemd", dirs).join("\n")).not.toContain("daemon")
    const d = installConfirmLines("install-daemon", "pm2", dirs).join("\n")
    expect(d).not.toContain("panel")
    expect(d).toContain("airlink-daemon (pm2)")
  })

  test("uninstall · pm2-managed app gets process copy, never unit files", () => {
    const lines = uninstallConfirmLines("uninstall-all", { panel: "pm2", daemon: "pm2" }, dirs)
    expect(lines).toContain("airlink-panel (pm2)  pm2 delete + pm2 save")
    expect(lines).toContain("airlink-daemon (pm2)  pm2 delete + pm2 save")
    expect(lines.some((l) => l.includes("unit"))).toBe(false)
    expect(lines.some((l) => l.includes("stop + disable"))).toBe(false)
    expect(lines.at(-1)).toBe("kept: node, docker, pm2")
  })

  test("uninstall · absent service says so but keeps the files promise", () => {
    const lines = uninstallConfirmLines("uninstall-all", { panel: "none", daemon: "none" }, dirs)
    expect(lines).toContain("airlink-panel  (no service - files still removed)")
    expect(lines).toContain("airlink-daemon  (no service - files still removed)")
    expect(lines).toContain("  files  /var/www/panel   rm -rf - the database lives inside")
    expect(lines.some((l) => l.includes("unit"))).toBe(false)
  })

  test("confirm options · action copy matches the box", () => {
    // no target service: must not promise "stops services"
    const none = uninstallConfirmOptions("uninstall-panel", { panel: "none", daemon: "systemd" })
    expect(none[0]).toEqual({ name: "Cancel", description: "back to the menu" })
    expect(none[1].name).toBe("Yes, remove panel")
    expect(none[1].description).toBe("no service - removes leftover files only")
    // a service exists on the action's target: standard copy
    const some = uninstallConfirmOptions("uninstall-all", { panel: "pm2", daemon: "none" })
    expect(some[1].description).toBe("stops services and deletes files")
    expect(some[1].name).toBe("Yes, remove everything")
    // uninstall-daemon only looks at daemon, panel mgr is irrelevant
    const d = uninstallConfirmOptions("uninstall-daemon", { panel: "systemd", daemon: "none" })
    expect(d[1].description).toBe("no service - removes leftover files only")
  })

  test("uninstall · mixed managers are stated per app", () => {
    const lines = uninstallConfirmLines("uninstall-all", { panel: "pm2", daemon: "systemd" }, dirs)
    expect(lines.join("\n")).toContain("airlink-panel (pm2)")
    expect(lines).toContain(`  unit   ${unitPath("daemon")}`)
    expect(lines.some((l) => l.includes("airlink-panel.service"))).toBe(false)
    expect(lines.some((l) => l.includes("database lives inside"))).toBe(false) // panel is pm2
    expect(lines.some((l) => l.includes("airlink-daemon.service  (stop + disable)"))).toBe(true)
  })

  test("uninstall · single-app actions show only that app", () => {
    const p = uninstallConfirmLines("uninstall-panel", { panel: "systemd", daemon: "none" }, dirs)
    expect(p.join("\n")).toContain("airlink-panel.service")
    expect(p.join("\n")).not.toContain("daemon")
    const d = uninstallConfirmLines("uninstall-daemon", { panel: "none", daemon: "pm2" }, dirs)
    expect(d.join("\n")).toContain("airlink-daemon (pm2)")
    expect(d.join("\n")).not.toContain("panel")
  })
})

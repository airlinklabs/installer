import { describe, expect, test } from "bun:test"
import { chooseMode, parseArgs, UsageError, USAGE, type Args } from "./src/config"

describe("parseArgs", () => {
  test("defaults", () => {
    const a = parseArgs([])
    expect(a.action).toBeNull()
    expect(a.service).toBe(process.platform === "darwin" ? "pm2" : "systemd")
    expect(a.serviceGiven).toBe(false)
    expect(a.yes).toBe(false)
    expect(a.plain).toBe(false)
    expect(a.demo).toBe(false)
    expect(a.help).toBe(false)
  })

  test("every action flag", () => {
    const cases: [string, Args["action"]][] = [
      ["--install-both", "install-both"],
      ["--install-panel", "install-panel"],
      ["--install-daemon", "install-daemon"],
      ["--uninstall-panel", "uninstall-panel"],
      ["--uninstall-daemon", "uninstall-daemon"],
      ["--uninstall-all", "uninstall-all"],
    ]
    for (const [flag, action] of cases) expect(parseArgs([flag]).action).toBe(action)
  })

  test("duplicates: last wins", () => {
    expect(parseArgs(["--install-panel", "--install-daemon"]).action).toBe("install-daemon")
    // pm2 last so the sequence is valid on every platform (macOS rejects systemd)
    expect(parseArgs(["--service", "systemd", "--service", "pm2"]).service).toBe("pm2")
  })

  test("--service both forms sets serviceGiven", () => {
    const spaced = parseArgs(["--service", "pm2"])
    expect(spaced.service).toBe("pm2")
    expect(spaced.serviceGiven).toBe(true)
    if (process.platform === "darwin") {
      expect(() => parseArgs(["--service=systemd"])).toThrow(UsageError)
    } else {
      const eq = parseArgs(["--service=systemd", "--install-panel"])
      expect(eq.service).toBe("systemd")
      expect(eq.serviceGiven).toBe(true)
    }
    // default stays when not given
    expect(parseArgs(["--install-panel"]).serviceGiven).toBe(false)
  })

  test("macOS rules: pm2 default, explicit systemd rejected", () => {
    const orig = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { value: "darwin" })
    try {
      expect(parseArgs([]).service).toBe("pm2")
      expect(() => parseArgs(["--service", "systemd"])).toThrow(UsageError)
      expect(() => parseArgs(["--service=systemd"])).toThrow(UsageError)
      expect(parseArgs(["--service", "pm2"]).service).toBe("pm2")
      expect(parseArgs(["--install-panel"]).service).toBe("pm2")
    } finally {
      Object.defineProperty(process, "platform", orig)
    }
  })

  test("invalid --service throws UsageError", () => {
    expect(() => parseArgs(["--service", "openrc"])).toThrow(UsageError)
    expect(() => parseArgs(["--service"])).toThrow(UsageError)
    expect(() => parseArgs(["--service="])).toThrow(UsageError)
  })

  test("unknown flag throws UsageError", () => {
    expect(() => parseArgs(["--wat"])).toThrow(UsageError)
    expect(() => parseArgs(["--install-panel", "-x"])).toThrow(UsageError)
  })

  test("boolean flags", () => {
    const a = parseArgs(["--yes", "--no-color", "--demo", "--help"])
    expect(a.yes && a.plain && a.demo && a.help).toBe(true)
    expect(parseArgs(["-h"]).help).toBe(true)
  })

  test("USAGE documents every flag", () => {
    for (const f of [
      "--install-both",
      "--install-panel",
      "--install-daemon",
      "--uninstall-panel",
      "--uninstall-daemon",
      "--uninstall-all",
      "--service",
      "--yes",
      "--no-color",
      "--demo",
      "--help",
    ])
      expect(USAGE).toContain(f)
  })
})

describe("chooseMode", () => {
  const tty = { stdinTty: true, stdoutTty: true }
  const base = { plain: false, action: null, yes: false }

  test("TTY + interactive intent -> TUI, no notice", () => {
    expect(chooseMode(base, tty)).toEqual({ tui: true, notice: null })
  })

  test("explicit --no-color -> plain, silent", () => {
    expect(chooseMode({ ...base, plain: true }, { stdinTty: false, stdoutTty: false })).toEqual({
      tui: false,
      notice: null,
    })
  })

  test("missing stdin TTY -> plain with notice", () => {
    const m = chooseMode(base, { stdinTty: false, stdoutTty: true })
    expect(m.tui).toBe(false)
    expect(m.notice).toContain("no TTY")
  })

  test("stdout redirected alone already disqualifies the TUI", () => {
    const m = chooseMode(base, { stdinTty: true, stdoutTty: false })
    expect(m.tui).toBe(false)
    expect(m.notice).toContain("no TTY")
  })

  test("action + --yes is the scripted path: plain, silent, TTY or not", () => {
    const scripted = { plain: false, action: "install-both" as const, yes: true }
    expect(chooseMode(scripted, tty)).toEqual({ tui: false, notice: null })
    expect(chooseMode(scripted, { stdinTty: false, stdoutTty: false })).toEqual({
      tui: false,
      notice: null,
    })
  })

  test("action without --yes keeps the TUI (confirm screen)", () => {
    expect(chooseMode({ plain: false, action: "uninstall-all" as const, yes: false }, tty)).toEqual({
      tui: true,
      notice: null,
    })
  })

  test("no action + no TTY -> plain with notice (usage error follows)", () => {
    const m = chooseMode(base, { stdinTty: false, stdoutTty: false })
    expect(m.tui).toBe(false)
    expect(m.notice).not.toBeNull()
  })
})

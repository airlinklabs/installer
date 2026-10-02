/*==============================================================================
 * Airlink installer - single file, runs on bun + @opentui/core
 *
 * Flow: welcome (banner + menu) -> service -> confirm -> steps + live logs -> summary
 *
 * Flags:
 *   --install-* / --uninstall-*   run one action directly (skips the menu)
 *   --service systemd|pm2         skip the service screen (default systemd)
 *   --yes                         skip the uninstall confirmation; with an action
 *                                 flag this is the scripted path (no TUI, exits alone)
 *   --no-color                    plain runner, no TUI, no TTY needed (explicit)
 *   --demo                        fake every step (UI preview, no changes)
 *   --help, -h                    usage; never needs a TTY
 *
 * No TTY (pipes, CI, redirected output) falls back to plain logs automatically
 * with a one-line stderr notice - automation never has to die on a TTY guard.
 *============================================================================*/

import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  parseColor,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core"
import { chooseMode, parseArgs, UsageError, USAGE, type Args } from "./src/config"
import {
  ACTION_TITLES,
  buildPlan,
  demoize,
  installConfirmLines,
  summaryLines,
  uninstallConfirmLines,
  uninstallConfirmOptions,
  type AppAction,
  type Cfg,
  type InstalledMgr,
  type ServiceMgr,
  type Step,
} from "./src/plan"
import { C, COLORS, ICONS, logoLines, SPINNER, termCols, termRows } from "./src/theme"
import { bindLogPane, plainMode, pushLog, resetLogBuf, scheduleLogRender, setLogViewLines } from "./src/log"
import { detectSystem, sys } from "./src/sys"
import { serviceInstalled } from "./src/service"

/*============================= args =======================================*/

function parse(): Args {
  try {
    return parseArgs(process.argv.slice(2))
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`error: ${e.message}\n`)
      console.log(USAGE)
      process.exit(2)
    }
    throw e
  }
}

const args = parse()
if (args.help) {
  console.log(USAGE)
  process.exit(0)
}

/** TUI needs stdin+stdout TTYs; --no-color and action+--yes are scripted paths;
 *  any other non-interactive terminal falls back to plain logs with a notice */
const mode = chooseMode(args, {
  stdinTty: process.stdin.isTTY === true,
  stdoutTty: process.stdout.isTTY === true,
})
if (mode.notice) console.error(mode.notice)
const useTui = mode.tui

let renderer: CliRenderer | null = null

/*============================= plain runner ===============================*/
/** --no-color: same plan, `✓/✗/⊘ name note` lines, logs straight to stdout */

async function runPlain(): Promise<void> {
  if (!args.action) {
    console.error("no action given - the interactive menu needs a TTY; pass an action flag:\n")
    console.log(USAGE)
    process.exit(2)
  }
  if (args.action.startsWith("uninstall") && !args.yes) {
    console.error("uninstall needs --yes in non-interactive mode (a TTY gives you the confirm screen)")
    process.exit(2)
  }
  const cfg: Cfg = { action: args.action, service: args.service, yes: args.yes, demo: args.demo }

  console.log(`airlink installer  ·  ${ACTION_TITLES[cfg.action]}  ·  ${sys.name} ${sys.arch}  ·  ${sys.family} pkgs`)
  const steps = buildPlan(cfg)
  if (cfg.demo) await demoize(steps, cfg)

  let failed = 0
  for (const s of steps) {
    s.state = "running"
    pushLog(`--- ${s.name} ---`)
    try {
      const res = await s.run()
      if (res && "skip" in res && res.skip) {
        s.state = "skipped"
        if (res.note) s.note = res.note
      } else if (res && "note" in res && res.note) {
        s.note = res.note
        s.state = /^(skip|n\/a)/.test(res.note) ? "skipped" : "done"
      } else {
        s.state = "done"
      }
    } catch (e) {
      s.state = "failed"
      s.note = (e as Error).message.slice(0, 80)
      failed++
      pushLog(`step failed: ${s.name}: ${(e as Error).message}`)
    }
    console.log(`${ICONS[s.state]} ${s.name}${s.note ? `  ${s.note}` : ""}`)
  }

  console.log("")
  for (const l of summaryLines(steps)) console.log(l)
  process.exit(failed ? 1 : 0)
}

/*============================= TUI ========================================*/

type ProgressUI = {
  screen: BoxRenderable
  headerText: TextRenderable
  stepTexts: TextRenderable[]
  footerText: TextRenderable
  stepsBox: BoxRenderable
  logBox: BoxRenderable
}

/** how many log lines fit: log box height (rows-6) - border - paddingY */
const logViewRows = (): number => Math.max(4, termRows() - 10)
// pane geometry shared by buildProgress and the resize handler
const stepPaneWidth = (): number => Math.min(52, Math.max(32, Math.floor(termCols() * 0.4)))
// logs box content width: terminal - body padX(1) - steps - gap(1) - padX(1), then border(2) + padX(2)
const logInnerWidth = (): number => Math.max(20, termCols() - stepPaneWidth() - 3) - 4

const MENU: { name: string; description: string; action: AppAction | "exit" }[] = [
  { name: "Install both", description: "panel + daemon from latest releases", action: "install-both" },
  { name: "Install panel", description: "/var/www/panel · airlink-panel service", action: "install-panel" },
  { name: "Install daemon", description: "/etc/daemon · airlink-daemon service", action: "install-daemon" },
  { name: "Uninstall panel", description: "requires confirmation", action: "uninstall-panel" },
  { name: "Uninstall daemon", description: "requires confirmation", action: "uninstall-daemon" },
  { name: "Uninstall everything", description: "requires confirmation", action: "uninstall-all" },
  { name: "Exit", description: "quit without changes", action: "exit" },
]

async function runTui(): Promise<void> {
  renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [] })
  const r = renderer

  let screen: "welcome" | "service" | "confirm" | "progress" = "welcome"
  let pending: AppAction | null = null
  // service manager chosen on the service screen (or via --service) - carried
  // into the confirm screen and from there into startRun
  let pendingService: ServiceMgr = args.service
  let installing = false
  let finished = false
  let spinnerTick = 0
  let steps: Step[] = []
  let prog: ProgressUI | null = null
  const timers: ReturnType<typeof setInterval>[] = []

  const quit = (): never => {
    for (const t of timers) clearInterval(t)
    try {
      renderer?.destroy()
    } catch {
      /* already gone */
    }
    return process.exit(process.exitCode ?? 0)
  }

  /* ---- welcome ---- */
  // responsive to terminal height (the banner file is 51x28 with blank margins);
  // row math includes the title line (OWN-WORLD: "adds its own title line"):
  //   rows >= 45: full file (28) + title + sys + 2-row menu + hint = 45
  //   rows >= 30: edge-trimmed art (13) + title + sys + 2-row menu + hint = 30
  //   else      : trimmed art (13) + title + sys + 1-row menu + hint = 23 (80x24 safe)
  const rows = termRows()
  const fullArt = rows >= 45
  const compactMenu = rows < 30
  const artLines = logoLines(fullArt)
  const logoBox = new BoxRenderable(r, {
    width: 53, // 51 art cols + paddingX 1 each side
    height: artLines.length,
    paddingX: 1,
    flexShrink: 0,
    backgroundColor: C.bg,
  })
  logoBox.add(
    new TextRenderable(r, { content: artLines.join("\n"), fg: parseColor(C.accent), flexShrink: 0 }),
  )

  // the abstract banner alone never names the product - the title line does
  const titleLine = new TextRenderable(r, {
    content: "airlink installer  ·  one command for panel + daemon",
    fg: parseColor(C.accent),
    flexShrink: 0,
  })

  const asRoot = process.getuid?.() === 0
  const sysLine = new TextRenderable(r, {
    content: `${sys.name}  ·  ${sys.arch}  ·  ${sys.family} pkgs  ·  ${asRoot ? "root" : "sudo"}`,
    fg: parseColor(C.dim),
  })

  const menuLabel = (m: (typeof MENU)[number]): string =>
    compactMenu ? `${m.name} — ${m.description}` : m.name
  const menu = new SelectRenderable(r, {
    id: "menu",
    width: compactMenu ? 60 : 46,
    height: compactMenu ? MENU.length : MENU.length * 2,
    flexShrink: 0,
    showDescription: !compactMenu,
    options: MENU.map((m) => ({ name: menuLabel(m), description: m.description })),
    backgroundColor: parseColor(C.panel),
    selectedBackgroundColor: parseColor(C.accent),
    selectedTextColor: parseColor(C.bg),
    textColor: parseColor(C.fg),
    descriptionColor: parseColor(C.dim),
  })

  const hint = new TextRenderable(r, {
    // spec copy; must fit 76 cols (80x24 - welcome padding) on ONE row.
    // fg, not dim: the actionable line carries safety meaning (contrast floor)
    content: "up/down move · enter select · install makes changes only after you confirm",
    fg: parseColor(C.fg),
    flexShrink: 0,
  })

  const welcome = new BoxRenderable(r, {
    id: "welcome",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    paddingX: 2,
    backgroundColor: C.bg,
  })
  welcome.add(logoBox)
  welcome.add(titleLine)
  welcome.add(sysLine)
  welcome.add(menu)
  welcome.add(hint)
  r.root.add(welcome)

  /* ---- service screen (installs only, skipped by --service) ---- */
  const svcSel = new SelectRenderable(r, {
    id: "service-sel",
    width: 56,
    height: 6, // 3 options x 2 rows (name + description)
    flexShrink: 0,
    options: [
      { name: "systemd", description: "enable on boot, journalctl logs (recommended)" },
      { name: "pm2", description: "pm2 save + startup" },
      { name: "Back", description: "back to the menu" },
    ],
    backgroundColor: parseColor(C.panel),
    selectedBackgroundColor: parseColor(C.accent),
    selectedTextColor: parseColor(C.bg),
    textColor: parseColor(C.fg),
    descriptionColor: parseColor(C.dim),
  })
  const svcTitle = new TextRenderable(r, { content: "how should the airlink services run?", fg: parseColor(C.fg) })
  const svcHint = new TextRenderable(r, {
    content: "systemd is the default · pm2 keeps apps stopped until you start them",
    fg: parseColor(C.dim),
  })
  const service = new BoxRenderable(r, {
    id: "service",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    paddingX: 2,
    gap: 1,
    backgroundColor: C.bg,
    visible: false,
  })
  service.add(svcTitle)
  service.add(svcSel)
  service.add(svcHint)
  r.root.add(service)

  /* ---- confirm screen (uninstalls, skipped by --yes) ---- */
  const confirmText = new TextRenderable(r, { content: "", fg: parseColor(C.fg), flexShrink: 0 })
  const confirmSel = new SelectRenderable(r, {
    id: "confirm-sel",
    width: 52,
    height: 4,
    flexShrink: 0,
    options: [
      { name: "Cancel", description: "back to the menu" },
      { name: "Yes, remove it", description: "stops services and deletes files" },
    ],
    backgroundColor: parseColor(C.panel),
    selectedBackgroundColor: parseColor(C.red),
    selectedTextColor: parseColor(C.bg),
    textColor: parseColor(C.fg),
    descriptionColor: parseColor(C.dim),
  })
  const confirmTitle = new TextRenderable(r, { content: "this removes services and files:", fg: parseColor(C.yellow) })
  const confirm = new BoxRenderable(r, {
    id: "confirm",
    width: 66,
    height: 20, // title + up to 9 lines + gaps + select (4) + padding
    flexDirection: "column",
    paddingX: 1,
    paddingY: 1,
    gap: 1,
    border: true,
    title: "confirm",
    titleColor: parseColor(C.red),
    backgroundColor: C.panel,
    visible: false,
  })
  confirm.add(confirmTitle)
  confirm.add(confirmText)
  confirm.add(confirmSel)
  r.root.add(confirm)

  /* ---- screen switching ---- */
  const show = (next: "welcome" | "service" | "confirm" | "progress"): void => {
    screen = next
    welcome.visible = next === "welcome"
    service.visible = next === "service"
    confirm.visible = next === "confirm"
    if (prog) prog.screen.visible = next === "progress"
    menu.blur()
    svcSel.blur()
    confirmSel.blur()
    if (next === "welcome") menu.focus()
    else if (next === "service") svcSel.focus()
    else if (next === "confirm") confirmSel.focus()
  }

  const openConfirm = async (action: AppAction, service: ServiceMgr): Promise<void> => {
    const dirs = {
      panel: process.env.AIRLINK_PANEL_DIR || "/var/www/panel",
      daemon: process.env.AIRLINK_DAEMON_DIR || "/etc/daemon",
    }
    let lines: string[]
    if (action.startsWith("install")) {
      confirmTitle.content = `installs with ${service}:`
      lines = installConfirmLines(action, service, dirs)
      confirmSel.options = [
        { name: "Cancel", description: "back to the menu" },
        { name: "Yes, install", description: "writes files and enables services" },
      ]
    } else {
      confirmTitle.content = "this removes services and files:"
      // detect the REAL manager per app before rendering - a pm2-managed app
      // gets process copy (no unit lines), an absent app says so; detection
      // failure falls back to the conservative systemd copy
      const mgrOf = async (app: "panel" | "daemon"): Promise<InstalledMgr> => {
        try {
          return await serviceInstalled(app)
        } catch {
          return "systemd"
        }
      }
      const mgrs: { panel: InstalledMgr; daemon: InstalledMgr } = {
        panel: action !== "uninstall-daemon" ? await mgrOf("panel") : "none",
        daemon: action !== "uninstall-panel" ? await mgrOf("daemon") : "none",
      }
      lines = uninstallConfirmLines(action, mgrs, dirs)
      confirmSel.options = uninstallConfirmOptions(action, mgrs)
    }
    confirmText.content = lines.join("\n")
    show("confirm")
  }

  /* ---- progress ---- */
  const buildProgress = (action: AppAction): void => {
    const stepW = Math.min(52, Math.max(32, Math.floor(termCols() * 0.4)))
    // as many step rows as fit inside the box (height - border - padding);
    // short terminals get a sliding window over the step list instead of bleed
    const innerRows = Math.max(6, termRows() - 6) - 4
    const visible = Math.min(steps.length, innerRows)
    const header = new BoxRenderable(r, { width: "100%", height: 3, flexDirection: "column", paddingX: 2, backgroundColor: C.panelAlt })
    const headerText = new TextRenderable(r, { content: `${ACTION_TITLES[action]}  ·  starting…`, fg: parseColor(C.fg) })
    header.add(headerText)

    const stepsBox = new BoxRenderable(r, {
      width: stepW,
      height: Math.max(6, termRows() - 6),
      flexDirection: "column",
      paddingX: 1,
      paddingY: 1,
      border: true,
      overflow: "hidden", // 22 steps can exceed 24-row panes - clip, don't bleed
      title: "steps",
      titleColor: parseColor(C.accent),
      backgroundColor: C.panel,
    })
    const stepTexts = Array.from({ length: visible }, () => {
      // one row per step: wrap + flex-shrink garbled the pane on 24-row terms
      const t = new TextRenderable(r, {
        content: "",
        fg: parseColor(C.fg),
        wrapMode: "none",
        flexShrink: 0,
      })
      stepsBox.add(t)
      return t
    })

    const logBox = new BoxRenderable(r, {
      // explicit width: opentui's flexGrow does not reserve the row `gap`, so a
      // flexed box ran 1 col past the viewport and lost its right border at 80
      width: Math.max(20, termCols() - stepW - 3),
      height: Math.max(6, termRows() - 6),
      flexDirection: "column",
      paddingX: 1,
      paddingY: 1,
      border: true,
      overflow: "hidden", // wrapped log lines clip, never bleed over the footer
      title: "logs",
      titleColor: parseColor(C.accent),
      backgroundColor: C.panel,
    })
    const logs = new TextRenderable(r, { content: "", fg: parseColor(C.fg), wrapMode: "word" })
    logBox.add(logs)
    // rows/cols inside the box: height - border(2) - paddingY(2) = rows-10; width - border - paddingX
    bindLogPane(logs, logViewRows(), logInnerWidth())

    const body = new BoxRenderable(r, { width: "100%", flexGrow: 1, flexDirection: "row", gap: 1, paddingX: 1 })
    body.add(stepsBox)
    body.add(logBox)

    const footer = new BoxRenderable(r, { width: "100%", height: 1, paddingX: 2, backgroundColor: C.panelAlt })
    const footerText = new TextRenderable(r, { content: "", fg: parseColor(C.dim) })
    footer.add(footerText)

    const pScreen = new BoxRenderable(r, {
      id: "progress",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: C.bg,
      visible: false,
    })
    pScreen.add(header)
    pScreen.add(body)
    pScreen.add(footer)
    r.root.add(pScreen)

    prog = { screen: pScreen, headerText, stepTexts, footerText, stepsBox, logBox }
  }

  /* ---- run ---- */
  const startRun = async (action: AppAction, service: ServiceMgr): Promise<void> => {
    const cfg: Cfg = { action, service, yes: args.yes, demo: args.demo }
    steps = buildPlan(cfg)
    if (cfg.demo) await demoize(steps, cfg)
    resetLogBuf()
    buildProgress(action)
    show("progress")
    installing = true

    const t0 = Date.now()
    const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1)
    // window over steps[]: the running step is pinned to the last visible row
    // (short terminals cannot show all 22); after the run the tail stays put
    let winStart = 0
    const refresh = (): void => {
      if (!prog) return
      const inner = prog.stepTexts.length
      const cur = steps.findIndex((s) => s.state === "running")
      if (steps.length <= inner) winStart = 0
      else if (cur >= 0) winStart = Math.max(0, Math.min(cur - inner + 1, steps.length - inner))
      else winStart = steps.length - inner // finished: show the last rows
      prog.stepTexts.forEach((t, i) => {
        const s = steps[winStart + i]
        if (!s) {
          t.content = ""
          return
        }
        const spin = s.state === "running" ? `${SPINNER[spinnerTick % SPINNER.length]} ` : ""
        t.content = `${spin}${ICONS[s.state]} ${s.name}${s.note ? `  ${s.note}` : ""}`
        t.fg = parseColor(COLORS[s.state])
      })
    }

    if (prog) prog.footerText.content = "running  ·  ctrl+c is ignored until the run finishes"
    timers.push(
      setInterval(() => {
        spinnerTick++
        if (!prog) return
        const idx = steps.findIndex((s) => s.state === "running")
        prog.headerText.content = `${ACTION_TITLES[action]}  ·  step ${idx >= 0 ? idx + 1 : steps.length}/${steps.length}  ·  ${elapsed()}s`
        refresh()
      }, 120),
    )

    let failed = 0
    for (const s of steps) {
      s.state = "running"
      if (prog) prog.headerText.content = `${ACTION_TITLES[action]}  ·  ${s.name}  ·  ${elapsed()}s`
      refresh()
      pushLog(`--- ${s.name} ---`)
      try {
        const res = await s.run()
        if (res && "skip" in res && res.skip) {
          s.state = "skipped"
          if (res.note) s.note = res.note
        } else if (res && "note" in res && res.note) {
          s.note = res.note
          s.state = /^(skip|n\/a)/.test(res.note) ? "skipped" : "done"
        } else {
          s.state = "done"
        }
      } catch (e) {
        s.state = "failed"
        s.note = (e as Error).message.slice(0, 80)
        failed++
        pushLog(`step failed: ${s.name}: ${(e as Error).message}`)
      }
      refresh()
    }

    for (const t of timers) clearInterval(t)
    timers.length = 0
    installing = false
    finished = true
    process.exitCode = failed ? 1 : 0

    if (prog) {
      prog.headerText.content = failed
        ? `${ACTION_TITLES[action]} finished with errors  ·  ${failed} step(s) failed`
        : `${ACTION_TITLES[action]} complete`
      prog.headerText.fg = parseColor(failed ? C.red : C.green)
      prog.footerText.content = "enter/q quit"
      // land on the summary (STORY): the steps served their purpose, so they
      // collapse and the logs take the full width - at 80x24 the whole summary
      // (release tag, dirs, .env state, manual steps) then fits unwrapped
      prog.stepsBox.visible = false
      prog.logBox.width = termCols() - 2 // body paddingX 1 each side
      setLogViewLines(logViewRows(), termCols() - 6) // - border 2 - paddingX 2
    }
    pushLog("")
    for (const l of summaryLines(steps)) pushLog(l)
    refresh()
    scheduleLogRender()
  }

  /* ---- wiring ---- */
  menu.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: { name: string }) => {
    const item = MENU.find((m) => menuLabel(m) === option.name)
    if (!item) return
    if (item.action === "exit") {
      quit()
      return
    }
    pending = item.action
    if (item.action.startsWith("install")) {
      if (args.serviceGiven) void startRun(item.action, args.service)
      else show("service")
    } else if (args.yes) {
      void startRun(item.action, args.service)
    } else {
      void openConfirm(item.action, args.service)
    }
  })

  svcSel.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: { name: string }) => {
    if (option.name === "Back") {
      show("welcome")
      return
    }
    if (!pending) return
    pendingService = option.name === "pm2" ? "pm2" : "systemd"
    // --yes skips the confirm review; otherwise the install stops there for a yes/no
    if (args.yes) void startRun(pending, pendingService)
    else void openConfirm(pending, pendingService)
  })

  confirmSel.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: { name: string }) => {
    if (option.name === "Cancel") {
      show("welcome")
      return
    }
    if (!pending) return
    void startRun(pending, pendingService)
  })

  r.keyInput.on("keypress", (key: KeyEvent) => {
    if (installing) {
      if (key.ctrl && key.name === "c") pushLog("ctrl+c ignored until the run finishes")
      return
    }
    if (finished) {
      if (key.name === "q" || key.name === "return" || key.name === "escape") quit()
      return
    }
    if (key.name === "escape" && screen === "service") {
      show("welcome")
      return
    }
    if (key.name === "q" || key.name === "escape") quit()
  })

  process.stdout.on("resize", () => {
    if (screen !== "progress") return
    if (finished && prog) {
      prog.stepsBox.visible = false
      prog.logBox.width = termCols() - 2
      setLogViewLines(logViewRows(), termCols() - 6)
    } else {
      setLogViewLines(logViewRows(), logInnerWidth())
    }
  })

  // an action flag skips the welcome menu; --service / --yes skip their screens
  if (args.action) {
    pending = args.action
    pendingService = args.service
    if (args.action.startsWith("install")) {
      // every install stops at a confirm review (the hint screen promise);
      // --service only skips the service *choice* screen
      if (args.serviceGiven) void openConfirm(args.action, args.service)
      else show("service")
    } else if (args.yes) {
      void startRun(args.action, args.service)
    } else {
      void openConfirm(args.action, args.service)
    }
  } else {
    show("welcome")
  }
  scheduleLogRender()
}

/*============================= entry ======================================*/

async function main(): Promise<void> {
  await detectSystem()
  if (!useTui) await runPlain()
  else await runTui()
}

main().catch((e) => {
  try {
    renderer?.destroy()
  } catch {
    /* noop */
  }
  console.error("installer crashed:", e)
  process.exit(1)
})

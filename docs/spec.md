# Airlink installer — engineering spec

Repo: `airlinklabs/installer` (this repo). Companion docs: `PRODUCT.md` (product truth), `.impeccable/surfaces/installer-installer-ts.md` (direction contract — the TUI's visual system).

## 1. Shape

```
installer.sh                      # bash bootstrap: downloads the prebuilt binary for this platform, runs it as root
README.md                         # one-liner usage, flags, uninstall, dev docs
PRODUCT.md
docs/spec.md                      # this file
.github/workflows/build.yml       # bun build --compile matrix -> rolling release `latest-build`
.github/workflows/pages.yml       # publish installer.sh (+ index) to GitHub Pages
installer/
  package.json  tsconfig.json  bun.lock
  installer.ts                    # TUI entry (OpenTUI): screens, step loop, plain runner, flags
  src/
    theme.ts                      # palette, ASCII logo, state icons/colors, spinner, term helpers, stripAnsi
    log.ts                        # ring buffer, render scheduling, plain-mode echo
    run.ts                        # run()/privCmd()/sudo()/haveCmd()/npmPriv()/nodeBinDir()
    sys.ts                        # os detect, package installs, node/toolchain/docker/www-data ensure
    release.ts                    # latest-release resolve, download+digest, staged strip-root extract
    service.ts                    # systemd + pm2 install/remove/status for panel & daemon
    panel.ts                      # panel install/uninstall steps
    daemon.ts                     # daemon install/uninstall steps (incl. libs/ native addon)
    plan.ts                       # buildPlan(action, cfg) -> Step[] ; summaryLines(...)
    config.ts                     # parseArgs(argv), usage text, env-overrides
  *.test.ts                       # bun:test unit tests for pure helpers
  e2e.sh                          # hermetic smoke tests (PATH-stubbed sudo/pkg managers)
```

Runtime: **bun** runs TS directly for development (no bundler). Distribution: CI compiles `installer.ts` with `bun build --compile` into single-file binaries per platform (see §2/§14). `tsc --noEmit` is the only build gate. Dependencies mirror the reference: `@opentui/core ^0.5.12`, dev `@types/bun ^1.4.2`, `@types/node ^26.6.3`, `typescript ^7.0.2`.

## 2. Bootstrap contract (`installer.sh`)

Distribution is a **prebuilt single-file binary**, not a source checkout: CI runs `bun build --compile` per platform and publishes the binaries on a rolling GitHub release; the bootstrap only downloads the right one and runs it. No git, no bun, no node_modules on the target machine. (Verified: a compiled OpenTUI binary renders correctly — `bun build --compile --target=bun-linux-arm64` embeds `libopentui.so` and runs standalone.)

- Download base: `DOWNLOAD_BASE="${AIRLINK_INSTALLER_DL:-https://github.com/airlinklabs/installer/releases/download/latest-build}"` → asset `$DOWNLOAD_BASE/airlink-installer-<platform>`.
- Asset names: `airlink-installer-linux-x64`, `airlink-installer-linux-arm64` (glibc targets only — `bun-linux-<arch>`; musl/Alpine is refused at detect time, see behavior step 2).
- Piped one-liner: `curl -fsSL https://airlinklabs.github.io/installer/installer.sh | bash` (README also documents the raw.githubusercontent fallback and `bash -s -- <flags>`).

Behavior (structure/comments follow the reference `Miserable_Xfce/init.sh`):
1. Pre-parse flags: `--no-color` (plain), `--help|-h` (no TTY, no root), `--demo` (no root), detect presence of any `--install-*`/`--uninstall-*` action flag. Everything is forwarded verbatim to the binary.
2. Platform detect: Linux only (else die naming the OS); arch `x86_64→x64`, `aarch64→arm64` (else die); musl (`ldd --version 2>&1 | grep -qi musl`) dies with an explicit "not supported" message (service management targets systemd distros). Unknown combos die with the supported list.
3. TTY guard (reference logic): TUI needs a TTY; piped stdin + openable `/dev/tty` + TTY stdout → `tty_in="</dev/tty"` so bash keeps reading the script from the pipe while the binary reads the terminal; **no TTY anywhere → warn and continue** — the binary auto-falls back to plain logs (a one-line stderr notice unless `--no-color` was explicit), so scripts never die on a TTY guard. `action + --yes` is the fully scripted path: plain, silent, no TUI even on a TTY (the TUI's end-of-run keypress would hang automation).
4. Root: needed unless `--help`, `--demo`, or plain-without-action (usage path). Non-root → `command -v sudo` check; with an openable `/dev/tty`: `sudo -v` once (interactive prompt); **without a TTY**: `sudo -n true` preflight (passwordless only — die with a clear message otherwise, never hang a script). Then the binary runs under `sudo` — it is root, so no keepalive is needed and the TS side's `privCmd` short-circuits to direct execution. Local dev (`bun installer.ts` as a normal user) still uses the `sudo -n` path.
5. Download: `curl -fL --retry 3 --connect-timeout 10` (wget fallback; neither → die) into `mktemp -d` with an EXIT trap for cleanup; 404 → die naming the platform asset and pointing at the repo's Actions tab. If `<asset>.sha256` downloads and `sha256sum` exists → verify, mismatch dies (absence never fatal).
6. Run: `"${SUDO[@]}" "$BIN" "$@"` (`</dev/tty` when piped), capture exit code, cleanup tmp, propagate rc.

## 3. CLI surface (`config.ts`)

```
flags (both TUI and plain):
  --install-both | --install-panel | --install-daemon
  --uninstall-panel | --uninstall-daemon | --uninstall-all
  --service systemd|pm2        default: systemd
  --yes                        skip the confirm screens; with an action
                               flag = scripted run (plain, no TUI, exits alone)
  --no-color                   plain runner explicitly (no TUI, no TTY needed)
  --demo                       every step faked (no system changes)
  --help, -h                   usage; never needs a TTY
```

- Mode selection (`chooseMode(args, io)` in `config.ts`, unit-tested): TUI requires stdin **and** stdout to be TTYs and interactive intent. Explicit `--no-color` → plain, silent. `action + --yes` → plain, silent even on a TTY (automation path — the TUI's end-of-run keypress would hang a script). No usable TTY otherwise → plain with a one-line stderr notice (`no TTY - falling back to plain logs (pass --no-color to skip this notice)`); dying on a TTY guard is no longer part of the contract.
- No action flag + TTY → welcome menu. No action flag in plain mode (explicit or auto-fallback) → error out with usage (exit 2): the menu needs a TTY.
- Uninstall in plain mode requires `--yes` (exit 2 otherwise). TUI uninstall always shows a confirm screen unless `--yes`.
- Env overrides (tests/sandbox): `AIRLINK_OS_RELEASE` (os-release path), `AIRLINK_PANEL_REPO` / `AIRLINK_DAEMON_REPO` (default `airlinklabs/panel`, `airlinklabs/daemon`), `AIRLINK_PANEL_URL` / `AIRLINK_DAEMON_URL` (direct zip URL — skips the API), `AIRLINK_PANEL_DIR` (default `/var/www/panel`), `AIRLINK_DAEMON_DIR` (default `/etc/daemon`), `AIRLINK_UNIT_DIR` (default `/etc/systemd/system`).

## 4. Shared types

```ts
// plan.ts / steps live here
type StepState = "pending" | "running" | "done" | "failed" | "skipped"
type StepResult = { note?: string; skip?: boolean } | void
type Step = { name: string; state: StepState; note?: string; run: () => Promise<StepResult> }

type AppAction = "install-both" | "install-panel" | "install-daemon"
               | "uninstall-panel" | "uninstall-daemon" | "uninstall-all"
type ServiceMgr = "systemd" | "pm2"
type Cfg = { action: AppAction; service: ServiceMgr; yes: boolean; demo: boolean }

buildPlan(cfg: Cfg): Step[]                 // ordered steps for the action
summaryLines(steps: Step[]): string[]       // post-run follow-ups, derived from step notes
demoize(steps: Step[]): Promise<void>       // swap every run for a faked ticker (--demo)
```

Step notes carry machine-readable facts the summary reads (e.g. `resolve latest release` gets note `Beta-2`, `download panel.zip` gets `sha256 ok` / `unverified`).

## 5. Release resolution (`release.ts`)

1. `GET https://api.github.com/repos/<repo>/releases/latest` with `User-Agent: airlink-installer`, `Accept: application/vnd.github+json`.
2. Validate: not `draft`, not `prerelease` (the endpoint already excludes them; assert anyway — prereleases must be invisible), `tag_name` non-empty, find asset by exact name (`panel.zip` / `daemon.zip`).
3. Download `browser_download_url` with `curl -fsSL --retry 3 -o <tmp>`.
4. If the API asset carried `digest: "sha256:<hex>"` → verify with `sha256sum` (or bun crypto); mismatch = step failure.
5. Fallback when the API is rate-limited/unreachable (403/429/network): resolve the tag from the redirect `curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/<repo>/releases/latest` → `.../releases/tag/<tag>`, then download `https://github.com/<repo>/releases/download/<tag>/<asset>` (no digest; note `unverified`).
6. `AIRLINK_*_URL` override skips 1–3 entirely.

## 6. Extraction (`release.ts` — `stageAndSwap`)

Release zips contain exactly one root dir (`panel-<sha>/`, `daemon-<sha>/`).

1. `unzip -q <zip> -o -d <staging>` (staging = mkdtemp under `/tmp`).
2. If staging holds exactly one entry and it is a directory → that is the root; otherwise staging itself is the root.
3. Preserve list (relative paths, e.g. `.env`): copy each existing file from the target dir to a temp backup **before** any deletion.
4. `rm -rf <target>` → `mkdir -p <target>` → move root contents in (same filesystem: rename, else copy fallback).
5. Restore preserved files that existed. Cleanup staging + backup on success; leave the backup behind on failure (log its path).
6. `unzip` missing → runtime-deps step installs it first (all package families).

Never extract the zip directly over a live target: stale files from a previous release must not survive an upgrade.

## 7. Dependencies (`sys.ts`)

Distro families: `arch | debian | fedora | suse | unknown` (parse `/etc/os-release`, `AIRLINK_OS_RELEASE` test hook; `unknown` → step failure with a clear message).

- **runtime deps (panel & daemon):** `curl`, `unzip`, `git` (bootstrap only, not here), `openssl` not required (randomness comes from bun's `crypto`), Node ≥ 18 + npm.
  - Node missing or major < 18 → NodeSource `setup_20.x` (debian/redhat), `pacman -S --needed --noconfirm nodejs npm` (arch), `zypper --non-interactive install nodejs npm` (suse). Then re-verify major ≥ 18 or fail.
- **build toolchain (both — bcrypt/prisma fallbacks, required by daemon addon):** debian `build-essential python3`, arch `base-devel python`, fedora `gcc-c++ make python3`, suse `gcc-c++ make python3`.
- **daemon extras:** Docker present + `systemctl is-active docker` (install `get.docker.com` on debian/redhat, `pacman -S docker`, `zypper install docker`; `enable --now docker`; tolerant if systemd unavailable — warn).
- **www-data:** `id www-data` else `useradd -r -M -s /usr/sbin/nologin www-data` (tolerant warn; services run as root so this is ownership hygiene per the READMEs).
- Batch install first, package-by-package retry on failure (reference pattern); `DEBIAN_FRONTEND=noninteractive`; arch uses `-Syu` never `-Sy`.

## 8. Privileged execution (`run.ts`)

- `privCmd(args)` → root ? args : `["sudo", "-n", ...args]` (the shipped binary runs as root — the bootstrap did `sudo -v`; the `sudo -n` path exists for local dev as a normal user, where the operator's own `sudo -v` covers it).
- `npmPriv(args, cwd)` → `privCmd(["env", `PATH=${nodeBinDir}:${process.env.PATH}`, "npm", ...args])` run with `cwd` — defeats sudo `secure_path` for nvm-installed node; `nodeBinDir = dirname(command -v node)`.
- All app-level commands (npm install/build, prisma, pm2, chown/chmod, systemctl, unzip of staging? no — unzip runs as the invoking user into /tmp staging; the target swap needs root) run privileged: the target dirs are root-owned and the invoking user is not root.
- `run()` streams stdout/stderr line-by-line into the log ring buffer (reference pump implementation).

## 9. Step tables

### install panel (`/var/www/panel`) and install daemon (`/etc/daemon`)

| # | panel step | daemon step |
|---|---|---|
| 1 | detect system (family, sudo credential `sudo -n true`, www-data ensure) | same + docker ensure |
| 2 | runtime deps (node≥18, npm, curl, unzip, toolchain) | same |
| 3 | resolve latest release → note `<tag>` | same |
| 4 | download `panel.zip` (+ digest verify) → note `sha256 ok`/`unverified` | download `daemon.zip` |
| 5 | extract to `AIRLINK_PANEL_DIR` (strip root, preserve `.env`) | extract to `AIRLINK_DAEMON_DIR` |
| 6 | write `.env` — fresh: `example.env` with `SESSION_SECRET` replaced by 32-hex random; existing `.env` restored untouched (note `fresh`/`preserved`) | write `.env` — **verbatim copy of `example.env`** when fresh; existing restored untouched (note `fresh`/`preserved`) |
| 7 | set permissions: `chown -R www-data:www-data`, `chmod -R 755` | same |
| 8 | `npm install` (dev deps kept — `npm run build` needs `tsc`) | `npm install` |
| 9 | database: `npx prisma generate` + `npx prisma db push --skip-generate` | — |
| 10 | build: `npm run build` | build: `npm run build` (tsc → `dist/`) |
| 11 | — | native addon: `cd libs && npm install && npm rebuild` (produces `libs/build/Release/{rename_at,secure_open}.node`; hard failure — `fs.ts` requires them) |
| 12 | install service (§10) | install service — **stopped/disabled state, see §10** |
| 13 | health check: probe `http://127.0.0.1:<PORT>` (PORT from `.env`, default 3000) with retries, warn-only | — (service intentionally not started) |

`install both` = panel steps 1–13 + daemon steps, with shared steps (detect, deps) run once: build the plan as `[detect, deps, ...panel unique, ...daemon unique]` — duplicates by name are collapsed (keep first).

### uninstall

`uninstall-panel`: stop+disable service (detect installed manager: unit file exists → systemd; `pm2 jlist` has the app → pm2), remove unit / `pm2 delete`, `rm -rf` target dir. Confirm first (TUI screen or `--yes`). Never touches Node/Docker/pm2.
`uninstall-daemon`: same for daemon. `uninstall-all`: daemon-uninstall steps + panel-uninstall steps (dedup by name).

## 10. Services (`service.ts`)

Unit names: `airlink-panel.service`, `airlink-daemon.service` (written to `AIRLINK_UNIT_DIR`).

systemd (panel):
```
[Unit] Description=Airlink Panel / After=network.target
[Service] Type=simple / User=root / WorkingDirectory=<dir>
Environment="PATH=<nodeBinDir>:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=<absolute npm path> run start / Restart=always
[Install] WantedBy=multi-user.target
```
- npm path resolved at install time (`command -v npm`); same wrapper for daemon (`After=network.target docker.service`).
- panel: `daemon-reload` + `enable --now` + wait for active.
- **daemon: unit written, NOT enabled/started** (user edits `/etc/daemon/.env` first — their explicit choice). Summary prints `systemctl enable --now airlink-daemon`.

pm2:
- `npmPriv(["install", "-g", "pm2"])` when missing.
- panel: `pm2 start <dir>/dist/app.js --name airlink-panel --cwd <dir>` (started), `pm2 save`.
- daemon: `pm2 start <dir>/dist/app.js --name airlink-daemon --cwd <dir>` then `pm2 stop airlink-daemon`, `pm2 save` (stays stopped, matching the systemd behavior).
- `pm2 startup systemd -u root --hp /root` via sudo — tolerant: on failure log the manual instruction.
- pm2 commands run through `privCmd` so the root pm2 daemon owns the apps (matches `User=root`).

## 11. TUI (`installer.ts`) — the built surface

Follow `.impeccable/surfaces/installer-installer-ts.md` (direction contract) exactly: Tokyo-night palette, boxed panes, lowercase mono titles, ASCII banner, `○ ▸ ✓ ✗ ⊘` state icons (never emoji), braille spinner. Reference implementation for structure: `/home/tmz/repos/Miserable_Xfce/installer/installer.ts` (screens, ring-buffer log pane, step table loop, `SelectRenderable` menus, `keyInput` handling).

Screens:
1. **welcome** — AIRLINK ASCII banner (accent), title line `airlink installer  ·  one command for panel + daemon` (accent — the abstract banner alone never names the product), dim system line `<distro> · <arch> · <family> pkgs · sudo`, select menu (width ~46):
   - `Install both` / desc `panel + daemon from latest releases`
   - `Install panel` / desc `/var/www/panel · airlink-panel service`
   - `Install daemon` / desc `/etc/daemon · airlink-daemon service`
   - `Uninstall panel` / `Uninstall daemon` / `Uninstall everything` (desc `requires confirmation`)
   - `Exit` / `quit without changes`
   - hint line: `up/down move · enter select · install makes changes only after you confirm`
2. **service screen** (install actions only) — select: `systemd — enable on boot, journalctl logs (recommended)` / `pm2 — pm2 save + startup` / `Back`. Preselect systemd. Choosing proceeds to the **confirm screen**. Action flags (`--service`) skip this screen.
3. **confirm screen** (every action unless `--yes` — installs stop here too, fulfilling the welcome hint "install makes changes only after you confirm"; Cancel preselected first):
   - **install**: title `installs with <mgr>:`; per app the service line (`airlink-panel.service  enable + start` for systemd / `airlink-panel (pm2)  start + pm2 save`; daemon variant notes it starts only after the `.env` edit), `unit` path (systemd only), `files <dir>`; footer `node, docker + build tools install only if missing`; select `Cancel` / `Yes, install`.
   - **uninstall**: title `this removes services and files:`; the manager per app is auto-detected before the box renders (systemd → unit path — honors `AIRLINK_UNIT_DIR`; pm2 → process copy, no unit lines; none → `(no service - files still removed)`, truthful because `rm -rf` runs unconditionally), footer `kept: node, docker, pm2`; select `Cancel` (default, first) / `Yes, remove <x>` with description `stops services and deletes files`, or `no service - removes leftover files only` when no target app has a service.
4. **progress** — 3-row header (`<action title> · step N/M <name> · <elapsed>s`), left `steps` pane (width `min(52, max(32, cols*0.4))`), right `logs` pane (explicit width — opentui's `flexGrow` does not reserve the row `gap`, a flexed box lost its right border at 80 — word-wrapped, tail budgeted by wrapped rows so the summary's manual-step commands are never clipped), footer with `enter/q quit` after finish. **After finish the `steps` pane collapses and `logs` takes the full width (`cols-2`)** so the entire summary (release tag, dirs, .env state, manual steps) fits at 80×24 — the STORY landing. Spinner on running step; header/result colors green/red but icons always carry state too.
5. **summary** — header turns green/red; log pane prints `summaryLines()` (release tag, paths, service commands, follow-ups: register first panel account via browser; edit daemon `.env` + start command; node registration in Admin → Nodes).

Interaction: `SelectRenderableEvents.ITEM_SELECTED` drives screens; `q`/`escape` quits from welcome/confirm, ignored while installing and while finished-until-`enter`; ctrl+c ignored during install (reference behavior). Layout adapts to `rows()/cols()` (min comfortable 80×24).

Plain runner (explicit `--no-color`, or any non-interactive invocation per §3 `chooseMode`): same plan, `✓/✗/⊘ name  note` lines, logs straight to stdout, exit 1 if any step failed.

Craft floor for this surface: state never color-only; errors name problem + recovery in the log; every brief requirement findable in the menu; essential text ≥ 4.5:1 on `#1a1b26` (fg `#c0caf5` ≈ 11:1, accent `#7aa2f7` ≈ 7:1, green/red/yellow ≥ 6:1) — the actionable hint line renders in fg; `dim #565f89` (≈ 2.7:1) is reserved for secondary decoration (system line, menu descriptions, footer), never for instructions; no dead ends (every screen has a back/exit).

## 12. Summary content (copy, `plan.ts`)

Panel installed: tag, dir, service mgr, `http://<first-ip>:<port>`, `→ open the URL and register the first account — the first signup becomes the admin`, service control line (`systemctl status airlink-panel` / `pm2 logs airlink-panel`).
Panel preserved config: `kept existing .env`.
Daemon installed: tag, dir, `→ edit /etc/daemon/.env (remote, key) — it currently holds the example defaults`, `→ systemctl enable --now airlink-daemon` (or pm2 start line), `→ panel: Admin → Nodes → Create, paste the key here`, service line.
Uninstall: what was removed; what was kept (node/docker/pm2).

## 13. Tests & gates

- `bunx tsc --noEmit` — clean, strict.
- `installer/*.test.ts` (bun:test): release JSON → tag/asset/url resolution + prerelease rejection + fallback URL derivation; `.env` writers (fresh vs preserved, SESSION_SECRET replaced, verbatim daemon mode); strip-root detection from file lists; `parseArgs` matrix (all flags, bad `--service`, plain-without-action, uninstall-without-`--yes`); plan assembly (dedup by name, step order per §9); summary lines from step notes.
- `installer/e2e.sh` — hermetic: throwaway `$HOME`, PATH stubs for `sudo`/package managers/`systemctl`/`useradd`/`chown`, `AIRLINK_*_DIR` + `AIRLINK_OS_RELEASE` + `AIRLINK_*_URL` overrides; scenarios: `--help` exit 0; `--no-color --demo --install-panel` exit 0 with `✓` lines and zero system changes; **auto-fallback:** `--demo --install-panel` without `--no-color` on a redirected stdout exits 0 with the `no TTY` notice; `--demo --install-both --yes` exits 0 **without** the notice (scripted path stays silent); `--no-color --uninstall-panel` without `--yes` exits 2; plain-without-action exits 2; bootstrap smoke: a fixture dir served as `file://` via `AIRLINK_INSTALLER_DL` → `installer.sh` detects platform, "downloads" the stub binary, execs it with flags verbatim (including a no-`--no-color` auto-fallback run), propagates rc, dies (rc 1) on sha256 mismatch. TUI screens are exercised by `--demo` runs locally, not in CI.
- Everything runs as the invoking user with `sudo -n` (the e2e stubs `sudo`).

## 14. Release automation + README

- `.github/workflows/build.yml` (binary distribution): on push to `main` (paths `installer/**`) + `workflow_dispatch`. Matrix: `ubuntu-24.04` (x64) and `ubuntu-24.04-arm` (arm64) — native runners so each target arch has its `@opentui/core-<arch>` native package on disk for embedding. Steps: checkout → `oven-sh/setup-bun` (pin 1.4.x) → `bun install --frozen-lockfile` → typecheck + `bun test` → `bun build --compile --minify --target=bun-linux-<arch> installer.ts --outfile dist/airlink-installer-linux-<arch>` + `sha256sum` sidecar → `--help`/`--demo` smoke test → upload artifacts. (glibc-only: no `-musl` targets.) A `publish` job (main only) creates the rolling release `latest-build` (`--prerelease`, so it never hijacks `releases/latest` for future version tags) via `gh release create` if absent, then `gh release upload ... --clobber` both platforms' assets. Permissions: `contents: write` on publish.
- `.github/workflows/pages.yml`: on push to `main`, build a `_site` containing `installer.sh` at the artifact root plus a minimal `index.html` (dark `#1a1b26`, accent `#7aa2f7`, the curl one-liner), deploy via `actions/deploy-pages`. README tells the maintainer to set repo Pages source to "GitHub Actions" once. Binaries are NOT on Pages — only on the release.
- README: the one-liner (`curl -fsSL https://airlinklabs.github.io/installer/installer.sh | bash`), raw fallback, flags table, what each action does, uninstall, how distribution works (bootstrap downloads ~100 MB binary for your platform from the `latest-build` release and runs it as root; checksummed), dev (`cd installer && bun install && bun installer.ts --demo`), requirements (Linux x64/arm64 glibc — musl/Alpine refused by the bootstrap, sudo — passwordless when non-interactive, TTY optional: no TTY falls back to plain logs), env overrides table.

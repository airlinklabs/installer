# Product

<!-- impeccable:product-schema 1 -->

## Platform

terminal

(TUI application running in a Linux terminal/ssh session; the schema's web/ios/android/adaptive enum does not cover CLI surfaces.)

## Stack

bun + TypeScript + @opentui/core for the TUI (pinned by the brief: "same technology as Miserable_Xfce"); a bash bootstrap script `installer.sh` as the curl|bash entry point; GitHub Actions (`bun build --compile`) ships the installer as prebuilt single-file binaries per platform/arch, which the bootstrap downloads and runs as root; installer.sh served at `https://airlinklabs.xyz/install` (content pasted into the site repo; this repo keeps the file as source of truth, GitHub Pages as an optional mirror). Recorded, not re-offered: the user pinned the stack in the original request.

## Users

Self-hosters and server admins deploying Airlink (panel + daemon) on a Linux or macOS machine, over ssh or locally, who want one command instead of following README steps by hand. Secondary: AirlinkLabs contributors running the installer from a local checkout.

## Product Purpose

One command (`curl -fsSL https://airlinklabs.xyz/install | bash`) installs, updates, and uninstalls the two Airlink applications — the panel and the daemon — from their GitHub release zips. Success means a working `airlink-panel` / `airlink-daemon` service with zero manual clone/npm/build/service steps, and a safe way to remove them again.

## Positioning

Release-zip based, not git-clone based: the installer never clones the app repos; it always pulls the latest non-prerelease release asset (`panel.zip` / `daemon.zip`) and extracts it into the canonical directories. Distribution of the installer itself is binary-based too: a TTY-aware bash bootstrap downloads the prebuilt `airlink-installer-<os>-<arch>` binary (built by CI from this repo, UPX-packed to ~27 MB with a `.gz` fallback asset, checksummed) matching the user's platform and executes it as root — no git, no bun, no source checkout on the target machine.

## Operating Context

- Linux with sudo (Debian/Ubuntu, RHEL-ish, Arch, SUSE families); systemd is the default service manager, pm2 an in-TUI alternative.
- macOS (arm64/Intel) with sudo and the Xcode Command Line Tools: pm2 is the only service manager (launchd via `pm2 startup`), packages come from Homebrew, Docker Desktop must be running for the daemon.
- Node.js >= 18 (bootstrap installs Node 20 via NodeSource/distro packages when missing), npm, unzip, curl; build toolchain (python3, make, g++) for the daemon's native `libs/` addon; Docker required by the daemon.
- GitHub: Releases API (`/releases/latest`, excludes drafts and prereleases) for tag + asset resolution, then direct asset download.
- Canonical targets: panel -> `/var/www/panel` (owner www-data), daemon -> `/etc/daemon` (owner www-data).
- Behavioral references: the old dialog-based `installer.sh` at airlinklabs/panel@f28eb37 (menu shape, systemd units `airlink-panel` / `airlink-daemon`, uninstall behavior) and the Miserable_Xfce installer (TUI architecture, sudo-keepalive bootstrap contract).

## Capabilities and Constraints

- Main menu: install both, install panel, install daemon, uninstall panel, uninstall daemon, uninstall everything, exit. A service-manager choice (systemd | pm2) is presented during install — pm2 only on macOS, where the screen is skipped for scripted runs.
- Always latest stable release only: `/releases/latest` API (404/draft/prerelease handled with a clear error), never a pinned or prerelease tag.
- Zips contain one root dir (`panel-<sha>/`, `daemon-<sha>/`); extraction strips it into the target dir.
- Panel install: deps -> download/extract -> chown www-data + chmod 755 -> `.env` from `example.env` with a generated `SESSION_SECRET` (assumption; everything else kept from example) -> `npm install` (dev deps kept: `tsc` is needed by `npm run build`) -> `prisma db push` + `prisma generate` -> `npm run build` -> service -> health check.
- Daemon install: deps (incl. build toolchain + Docker) -> download/extract -> chown www-data + chmod 755 -> `.env` written verbatim from `example.env` (user's explicit decision: they edit it manually before starting) -> `npm install` -> `npm run build` -> build `libs/` native addon (`npm install` + node-gyp rebuild) -> service installed but left stopped/disabled (honors "edits it manually before starting"); the completion summary prints the exact start command.
- No admin-account creation (user's explicit decision): the panel's first-user registration flow in the browser creates the admin.
- Service management: chosen in the TUI (systemd | pm2; pm2 only on macOS). systemd writes `/etc/systemd/system/airlink-{panel,daemon}.service`; panel is enabled and started, daemon stays stopped until the user edits its `.env`. pm2 path installs pm2, starts the panel (`dist/app.js`, app dir as cwd), leaves the daemon stopped, `pm2 save`; `pm2 startup` is attempted tolerantly (launchd agent on macOS, `startup systemd -u root` on Linux).
- Reinstall/upgrade (running an install action when the app dir already exists): back up the existing `.env` to `<app>.env.bak-<timestamp>` before replacing files, then restore it; never silently destroy user config.
- Every install stops at a confirm review before anything is written — chosen service manager, unit path + target dir per app, `Cancel` preselected — so the welcome hint "install makes changes only after you confirm" is literally true; `--yes` skips it.
- Uninstall: confirm first, then stop/disable the service (systemd unit or pm2 process), remove the unit / delete the pm2 app, remove the app directory. It does not remove Node, Docker, or pm2.
- Bootstrap flags forwarded to the TUI: `--help` (no TTY needed), `--no-color` (plain logs explicitly, pipes/CI), `--demo` (UI preview, no system changes), `--yes` (skips the confirm screens; with an action flag it is the fully scripted run — plain logs, no TUI, exits with the result).
- Bootstrap contract: the binary runs as root (the bootstrap did one interactive `sudo -v`; no keepalive needed), so the TS side executes privileged commands directly; piped stdin hands the TUI `/dev/tty`; local dev checkout (`bun installer.ts` as a normal user) uses the `sudo -n` path with the operator's own `sudo -v`.
- `curl | bash` must never hang a pipe: `--help` and `--no-color` work without a TTY, and a missing TTY degrades to plain logs (one-line notice) instead of erroring out — scripts pass action flags directly.
- Plain mode prints `✓/✗/⊘ step note` lines and exits non-zero on failure (scriptable/CI-usable).

## Brand Commitments

"Airlink" / "AirlinkLabs"; repo airlinklabs/installer; GPL-2.0 (repo LICENSE); MIT for the apps themselves. The reference installer's Apache-2.0 header on the old script is not binding on this repo. Product vocabulary: "panel", "daemon", "node" (daemon registered in the panel).

## Evidence on Hand

- Old installer: https://github.com/airlinklabs/panel/raw/f28eb37a539ecdee0d1be5edb537b916ab359b2b/installer.sh (menu, config flow, systemd, uninstall).
- Latest releases (2026-10-01): panel tag `Beta-2` asset `panel.zip` (940 KB, prerelease:false), daemon tag `beta-2` asset `daemon.zip` (67 KB, prerelease:false); both extracted at /tmp/opencode/airlink-releases/x for inspection.
- Panel package.json/scripts, `example.env`, `src/handlers/envLoader.ts`, first-user registration in `src/modules/auth/*` (validated against source, not assumed).
- Daemon `example.env`, `src/utils/config.ts` (lowercase `remote`/`key`/`port` are what the code reads), `src/handlers/filesystem/fs.ts` requiring `libs/build/Release/*.node`.
- Reference installer: /home/tmz/repos/Miserable_Xfce/{init.sh,installer/installer.ts}.
- Absences that later work must not fabricate: no lockfiles in either release zip; no `seed` script in panel package.json (the old installer's `npm run seed` and admin-registration steps are obsolete); daemon README's `PORT`/`KEY`/`SFTP_PORT` names do not match the code (`port`/`key`).

## Product Principles

1. Release artifacts only — never clone or build the app repos from git.
2. Latest stable only — prereleases and drafts are invisible to this installer.
3. User config is sacred — `.env` survives reinstalls; destructive actions require confirmation.
4. Nothing to memorize — every required follow-up (daemon .env edit, node registration, panel first-user signup) is printed in the completion summary.
5. The pipe never lies — any flag works without a TTY; the TUI degrades to plain logs.

## Accessibility & Inclusion

Must work over ssh in minimal terminals: plain mode engages automatically for no-TTY environments (and explicitly via `--no-color`), keyboard-only operation, steps/logs readable at 80x24 (layout adapts to `rows()/cols()`), success/failure never conveyed by color alone (icons ✓/✗/⊘).

## Assumptions (inferred, labeled per init)

- The bootstrap is served at `https://airlinklabs.xyz/install` — the content of `installer.sh` is pasted into the airlinklabs.xyz site repo, while this repo keeps the file as source of truth (overridable via `AIRLINK_INSTALLER_URL` / raw.githubusercontent fallback).
- Distribution targets a rolling ordinary release `latest-build` on airlinklabs/installer — created with `--latest=false` (never `--prerelease`), assets `airlink-installer-<os>-<arch>` for linux/darwin × x64/arm64 (UPX-packed plain form, `.gz` form when the packer can't pack a target) + `.sha256` sidecars — so the bootstrap URL is stable and `releases/latest` stays free for future version tags.
- `SESSION_SECRET` is generated rather than left as `change_me` (security floor; not a product feature).
- Node bootstrap targets Node 20 (matches the old installer; READMEs require >= 18).

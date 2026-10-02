# Airlink installer

![installer-demo-gif](./docs/demo.gif)


One command that installs and uninstalls the Airlink **panel** and **daemon** on Linux — pulling only the latest stable GitHub release zips (`panel.zip` / `daemon.zip`), never git clones of the apps, never prereleases.

## Install

Primary:

```sh
curl -fsSL https://airlinklabs.xyz/install | bash
```

Fallback (raw GitHub):

```sh
curl -fsSL https://raw.githubusercontent.com/airlinklabs/installer/main/installer.sh | bash
```

With flags — everything after `--` is forwarded straight to the installer:

```sh
curl -fsSL https://airlinklabs.xyz/install | bash -s -- --install-both --service systemd
curl -fsSL https://raw.githubusercontent.com/airlinklabs/installer/main/installer.sh | bash -s -- --install-daemon --yes
```

## What it does

| Action | Result |
| --- | --- |
| **Install both** | Panel + daemon steps in one run (shared detect/deps steps run once) |
| **Install panel** | Extracts into `/var/www/panel`, installs the `airlink-panel` service — **starts immediately** |
| **Install daemon** | Extracts into `/etc/daemon`, installs the `airlink-daemon` service — **left stopped** until you edit `.env` |
| **Uninstall panel** | Stops/disables the service, removes the unit + `/var/www/panel` (confirms first) |
| **Uninstall daemon** | Stops/disables the service, removes the unit + `/etc/daemon` (confirms first) |
| **Uninstall everything** | Daemon + panel uninstall in one run; never removes Node, Docker, or pm2 |

- **Latest-release resolution:** `api.github.com/.../releases/latest` → `panel.zip` / `daemon.zip`. Prereleases and drafts are invisible; the sha256 digest is verified when the API provides one.
- **Service choice:** `systemd` (default) or `pm2` — chosen in the TUI, then a confirm screen shows exactly what will be written before anything runs.
- **Daemon `.env`** is written verbatim from `example.env` — you edit it before starting.

> **After install**
>
> - **Panel:** open `http://<ip>:3000` and register the first account — the first signup becomes the admin.
> - **Daemon:** edit `/etc/daemon/.env` (`remote`, `key`), then run `systemctl enable --now airlink-daemon`, then register the node in the panel under **Admin → Nodes**.

## Flags

| Flag | Effect |
| --- | --- |
| `--install-both` | Install panel + daemon |
| `--install-panel` | Install the panel only |
| `--install-daemon` | Install the daemon only |
| `--uninstall-panel` | Remove the panel service + files |
| `--uninstall-daemon` | Remove the daemon service + files |
| `--uninstall-all` | Remove both |
| `--service systemd\|pm2` | Service manager for installs (default: `systemd`) |
| `--yes` | Skip the confirm screens (required for uninstalls without a TTY); **with an action flag this is the scripted path** — plain logs, no TUI, exits on its own |
| `--no-color` | Plain logs explicitly (no TTY needed; scriptable/CI) |
| `--demo` | Every step faked — UI preview, no system changes |
| `--help`, `-h` | Usage; never needs a TTY or sudo |

Mode selection: TTY + interactive intent → TUI menu. No usable TTY (pipes, CI, redirected output) → **plain logs automatically** with a one-line stderr notice — scripts never have to pass `--no-color`. Action + `--yes` → plain and silent even on a TTY.

```sh
# interactive
curl -fsSL https://airlinklabs.xyz/install | bash

# scripted / CI: no TTY needed, exit code is the result
curl -fsSL https://airlinklabs.xyz/install | bash -s -- --install-both --yes
./installer.sh --uninstall-all --yes            # rc 0 = gone, rc != 0 = failed
./installer.sh --demo --install-both            # headless UI preview
```

No action flag + TTY → interactive welcome menu. No action flag without a TTY → usage, exit 2.

## How distribution works

`installer.sh` is only a bootstrap (~5 KB): it detects your platform (`linux-x64`/`linux-arm64` on glibc; musl/Alpine is refused with an explanation), downloads the matching prebuilt `airlink-installer-*` binary (~100 MB, self-contained: bun runtime + OpenTUI + the installer) from the rolling [`latest-build`](https://github.com/airlinklabs/installer/releases/tag/latest-build) release, verifies its sha256 when present, and executes it **as root** (one interactive `sudo -v`). No git, no bun, no source checkout ever touches your machine. The binaries are built by `.github/workflows/build.yml` with `bun build --compile` on every push to `main`.

## Environment overrides

| Variable | Default | Purpose |
| --- | --- | --- |
| `AIRLINK_INSTALLER_DL` | `https://github.com/airlinklabs/installer/releases/download/latest-build` | Bootstrap binary download base |
| `AIRLINK_OS_RELEASE` | `/etc/os-release` | os-release path (tests/sandbox) |
| `AIRLINK_PANEL_REPO` | `airlinklabs/panel` | Panel release repo |
| `AIRLINK_DAEMON_REPO` | `airlinklabs/daemon` | Daemon release repo |
| `AIRLINK_PANEL_URL` | — | Direct `panel.zip` URL — skips the API |
| `AIRLINK_DAEMON_URL` | — | Direct `daemon.zip` URL — skips the API |
| `AIRLINK_PANEL_DIR` | `/var/www/panel` | Panel install dir |
| `AIRLINK_DAEMON_DIR` | `/etc/daemon` | Daemon install dir |
| `AIRLINK_UNIT_DIR` | `/etc/systemd/system` | systemd unit target |

## Requirements

- Linux on x86_64 or aarch64 with glibc (Debian/Ubuntu, RHEL-ish, Arch, SUSE) — musl/Alpine is not supported
- `curl` or `wget` to fetch the binary; sudo (or root) for install/uninstall actions
- A TTY — or `--no-color` for pipes/CI
- Network (GitHub Releases API + downloads)
- Node ≥ 18 — installed automatically if missing
- Docker — installed automatically for the daemon

## Development

```sh
cd installer
bun install
bun installer.ts --demo   # TUI preview, no system changes
bun test                  # unit tests
bunx tsc --noEmit         # type gate
bash e2e.sh               # hermetic smoke tests

# cross-build any target from anywhere (what CI does):
bun build --compile --minify --target=bun-linux-x64 installer.ts --outfile dist/airlink-installer-linux-x64
```

## Serving the bootstrap

The primary entry point is `https://airlinklabs.xyz/install`: the content of this repo's `installer.sh` is pasted into the airlinklabs.xyz site repo and served at `/install` — this repo stays the source of truth, and the raw GitHub URL above always mirrors it. Optionally, `.github/workflows/pages.yml` stages `installer.sh` + a landing page to GitHub Pages as a second mirror — set [repo Settings → Pages](https://github.com/airlinklabs/installer/settings/pages) to **Source: GitHub Actions** to enable it. `.github/workflows/build.yml` publishes the binaries to the `latest-build` release automatically (needs `contents: write`, granted in the workflow).

## License

GPL-2.0 — see [LICENSE](LICENSE).

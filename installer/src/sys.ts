/*============================= system detect ==============================*/

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { pushLog } from "./log"
import { capture, haveCmd, privCmd, quiet, run } from "./run"

export type Family = "arch" | "debian" | "fedora" | "suse" | "darwin" | "unknown"

export const sys = {
  name: process.platform === "darwin" ? "macOS" : "Linux",
  id: "",
  idLike: "",
  family: "unknown" as Family,
  arch: process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch,
}

export async function detectSystem(): Promise<void> {
  if (process.platform === "darwin") {
    // macOS has no os-release; sw_vers is the identity. AIRLINK_OS_RELEASE is
    // the Linux test hook and does not apply here.
    sys.id = "macos"
    sys.family = "darwin"
    const v = (await capture(["sw_vers", "-productVersion"]))?.trim()
    sys.name = `macOS${v ? ` ${v}` : ""}`
    return
  }
  // AIRLINK_OS_RELEASE is a test hook (e2e drives unsupported-distro detection)
  const src = process.env.AIRLINK_OS_RELEASE || "/etc/os-release"
  try {
    const txt = await readFile(src, "utf8")
    for (const line of txt.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/)
      if (!m) continue
      const val = m[2].replace(/^"|"$/g, "")
      if (m[1] === "ID") sys.id = val
      if (m[1] === "ID_LIKE") sys.idLike = val
      if (m[1] === "PRETTY_NAME") sys.name = val
    }
  } catch {
    /* no os-release: keep defaults */
  }
  const hay = `${sys.id} ${sys.idLike}`.toLowerCase()
  if (/(arch|manjaro|endeavouros|garuda|artix)/.test(hay)) sys.family = "arch"
  else if (/(debian|ubuntu|linuxmint|pop|kali|raspbian)/.test(hay)) sys.family = "debian"
  else if (/(fedora|rhel|centos|rocky|almalinux|nobara)/.test(hay)) sys.family = "fedora"
  else if (/(suse|opensuse|sles)/.test(hay)) sys.family = "suse"
  else sys.family = "unknown"
}

/*============================= package sets ===============================*/

/** brew as argv prefix. Homebrew refuses to run as root, so when the shipped
 *  (root) binary must install something we drop to the sudo-invoking user;
 *  the two known prefixes beat PATH lookups because sudo may reset it. */
function brewBase(): string[] {
  const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find((c) => existsSync(c)) ?? "brew"
  const uid = process.getuid?.() ?? 0
  const user = process.env.SUDO_USER
  return uid === 0 && user ? ["sudo", "-u", user, brew] : [brew]
}

export function pkgInstallCmd(pkgs: string[]): string[] {
  switch (sys.family) {
    case "arch":
      return privCmd(["pacman", "-S", "--needed", "--noconfirm", ...pkgs])
    case "debian":
      return privCmd(["apt-get", "install", "-y", ...pkgs])
    case "fedora":
      return privCmd(["dnf", "install", "-y", ...pkgs])
    case "suse":
      return privCmd(["zypper", "--non-interactive", "install", ...pkgs])
    case "darwin":
      return [...brewBase(), "install", ...pkgs]
    default:
      return ["false"]
  }
}

let indexRefreshed = false

export async function refreshIndex(): Promise<void> {
  switch (sys.family) {
    // -Syu, never -Sy: syncing the db without upgrading installed packages is a
    // partial upgrade, which Arch explicitly does not support
    case "arch":
      await run(privCmd(["pacman", "-Syu", "--noconfirm"]))
      break
    case "debian":
      await run(privCmd(["apt-get", "update"]), { env: { DEBIAN_FRONTEND: "noninteractive" } })
      break
    case "suse":
      await run(privCmd(["zypper", "refresh"]))
      break
    default:
      break // dnf refreshes lazily, brew has no index to refresh
  }
}

/** batch first, then package-by-package so one unknown name cannot abort all */
export async function installPkgs(pkgs: string[]): Promise<{ missing: string[] }> {
  if (!pkgs.length) return { missing: [] }
  if (sys.family === "unknown") {
    throw new Error(`cannot install packages on an unknown distro (ID=${sys.id || "?"}) - install manually and re-run`)
  }
  if (!indexRefreshed) {
    await refreshIndex()
    indexRefreshed = true
  }
  const env: Record<string, string> = sys.family === "debian" ? { DEBIAN_FRONTEND: "noninteractive" } : {}
  const code = await run(pkgInstallCmd(pkgs), { env })
  if (code === 0) return { missing: [] }
  pushLog(`batch install failed (exit ${code}) - retrying package-by-package`)
  const missing: string[] = []
  for (const p of pkgs) {
    const c = await run(pkgInstallCmd([p]), { env })
    if (c !== 0) missing.push(p)
  }
  if (missing.length) pushLog(`not installable: ${missing.join(", ")}`)
  return { missing }
}

/*============================= ensure =====================================*/

async function nodeMajor(): Promise<number> {
  const out = await capture(["node", "-v"])
  if (!out) return 0
  const m = out.trim().match(/^v(\d+)/)
  return m ? parseInt(m[1], 10) : 0
}

/** node >= 18 (with npm): NodeSource 20 on debian/fedora, distro packages
 *  elsewhere, Homebrew's `node` on macOS */
export async function ensureNode(): Promise<void> {
  const major = await nodeMajor()
  if (major >= 18) {
    pushLog(`node v${major} already installed`)
    return
  }
  pushLog(major ? `node v${major} is too old - installing node 20` : "node not found - installing node 20")
  switch (sys.family) {
    case "debian":
      await run(privCmd(["sh", "-c", "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -"]))
      await installPkgs(["nodejs"])
      break
    case "fedora":
      await run(privCmd(["sh", "-c", "curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -"]))
      await installPkgs(["nodejs"])
      break
    case "arch":
      await installPkgs(["nodejs", "npm"])
      break
    case "suse":
      await installPkgs(["nodejs", "npm"])
      break
    case "darwin":
      if ((await run([...brewBase(), "install", "node"])) !== 0) {
        pushLog("brew install node failed - install node >= 18 (brew or nvm) yourself if this keeps failing")
      }
      break
    default:
      throw new Error("cannot install node on an unknown distro - install node >= 18 yourself and re-run")
  }
  const after = await nodeMajor()
  if (after < 18) {
    throw new Error(`node is still ${after ? `v${after}` : "missing"} - install node >= 18 (e.g. via nvm) and re-run`)
  }
  if (!(await haveCmd("npm"))) throw new Error("npm missing after the node install - install npm and re-run")
}

// toolchain: bcrypt/prisma fallbacks on panel, required by the daemon libs/ addon
// (macOS: the Xcode Command Line Tools cover this - verified in ensureRuntimeDeps)
const TOOLCHAIN: Record<Family, string[]> = {
  arch: ["base-devel", "python"],
  debian: ["build-essential", "python3"],
  fedora: ["gcc-c++", "make", "python3"],
  suse: ["gcc-c++", "make", "python3"],
  darwin: [],
  unknown: [],
}

/** curl + unzip + build toolchain + node; curl/unzip are hard-verified after */
export async function ensureRuntimeDeps(): Promise<void> {
  if (sys.family === "unknown") {
    throw new Error(`unsupported distro (ID=${sys.id || "?"}) - Debian/Ubuntu, RHEL/Fedora, Arch and openSUSE are supported`)
  }
  if (sys.family === "darwin") {
    // CLT first: without it make/g++/python3 are xcode-select shims that only
    // print an install prompt. Homebrew is needed only when node is missing.
    if ((await quiet(["xcode-select", "-p"])) !== 0) {
      throw new Error("Xcode Command Line Tools are required - run `xcode-select --install`, wait, then re-run")
    }
    await ensureNode()
    if (!(await haveCmd("curl"))) throw new Error("curl is missing - install it with Homebrew and re-run")
    if (!(await haveCmd("unzip"))) throw new Error("unzip is missing - install it with Homebrew and re-run")
    pushLog("runtime deps ok (macOS: CLT + node)")
    return
  }
  const need = new Set<string>()
  if (!(await haveCmd("curl"))) need.add("curl")
  if (!(await haveCmd("unzip"))) need.add("unzip")
  if (!(await haveCmd("g++")) || !(await haveCmd("make"))) for (const p of TOOLCHAIN[sys.family]) need.add(p)
  if (!(await haveCmd("python3"))) need.add(sys.family === "arch" ? "python" : "python3")
  if (need.size) {
    pushLog(`installing: ${[...need].join(", ")}`)
    // missing packages are reported by installPkgs; curl/unzip hard-fail below,
    // toolchain absence surfaces in the daemon addon step (hard failure there)
    await installPkgs([...need])
  }
  await ensureNode()
  if (!(await haveCmd("curl"))) throw new Error("curl is missing - install it with your package manager and re-run")
  if (!(await haveCmd("unzip"))) throw new Error("unzip is missing - install it with your package manager and re-run")
  pushLog("runtime deps ok")
}

/** Docker for the daemon: present + active, else install (get.docker.com on
 *  debian/fedora, distro packages on arch/suse, Docker Desktop cask on macOS;
 *  tolerant when systemd is absent) */
export async function ensureDocker(): Promise<void> {
  if (sys.family === "darwin") {
    // macOS: no auto-start of engines - the CLI must exist AND an engine must
    // be running (Docker Desktop app or colima) before the daemon can work
    if (!(await haveCmd("docker"))) {
      pushLog("installing Docker Desktop (brew cask)")
      await run([...brewBase(), "install", "--cask", "docker"]) // best effort; verified below
    }
    if (!(await haveCmd("docker"))) {
      throw new Error("docker is missing - install Docker Desktop (brew install --cask docker) or colima, start it, and re-run")
    }
    if ((await quiet(["docker", "info"])) !== 0) {
      throw new Error("docker is installed but not running - start Docker Desktop (or: colima start) and re-run")
    }
    pushLog("docker running")
    return
  }
  if (await haveCmd("docker")) {
    if (await haveCmd("systemctl")) {
      if ((await quiet(["systemctl", "is-active", "--quiet", "docker"])) === 0) {
        pushLog("docker already installed and active")
        return
      }
      pushLog("docker installed but not active - enabling")
      if ((await run(privCmd(["systemctl", "enable", "--now", "docker"]))) !== 0) {
        pushLog("could not start docker - run: systemctl enable --now docker")
      }
    } else {
      pushLog("docker already installed")
    }
    return
  }
  pushLog("installing docker")
  switch (sys.family) {
    case "debian":
    case "fedora":
      if ((await run(privCmd(["sh", "-c", "curl -fsSL https://get.docker.com | sh"]))) !== 0) {
        throw new Error("the docker install script failed - install docker manually (docs.docker.com/engine/install) and re-run")
      }
      break
    case "arch":
    case "suse":
      await installPkgs(["docker"])
      if (!(await haveCmd("docker"))) throw new Error("docker did not install - install it manually and re-run")
      break
    default:
      throw new Error("cannot install docker on an unknown distro - install it manually and re-run")
  }
  if (await haveCmd("systemctl")) {
    if ((await run(privCmd(["systemctl", "enable", "--now", "docker"]))) !== 0) {
      pushLog("could not start docker - run: systemctl enable --now docker")
    }
  } else {
    pushLog("no systemctl here - start docker with your init system")
  }
}

/** ownership hygiene: services run as root, but the panel READMEs expect
 *  a www-data user to exist - tolerant if useradd is unavailable (macOS has
 *  no www-data and services run as root, so there is nothing to create) */
export async function ensureWwwData(): Promise<void> {
  if (sys.family === "darwin") return
  if ((await quiet(["id", "www-data"])) === 0) return
  const c = await run(privCmd(["useradd", "-r", "-M", "-s", "/usr/sbin/nologin", "www-data"]))
  if (c !== 0) pushLog("could not create www-data - services run as root, this was ownership hygiene only")
}

/** bun's crypto - no openssl needed on the target machine */
export async function randomHex(bytes: number): Promise<string> {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")
}

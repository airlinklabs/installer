/*============================= daemon steps ===============================*/
// Install/uninstall steps for /etc/daemon. Fresh installs copy example.env
// VERBATIM (remote/key are placeholders): the daemon service is installed but
// left stopped until the user edits it (PRODUCT decision). The libs/ native
// addon is a hard failure - fs.ts requires rename_at/secure_open at runtime.

import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Cfg, Step } from "./plan"
import { pushLog } from "./log"
import { downloadAsset, fetchLatestRelease, stageAndSwap, type ReleaseInfo } from "./release"
import { npmPriv, privCmd, privEnv, run } from "./run"
import { installService, removeService } from "./service"
import { sys } from "./sys"

const daemonDir = () => process.env.AIRLINK_DAEMON_DIR || "/etc/daemon"

export function daemonInstallSteps(cfg: Cfg): Step[] {
  const dir = daemonDir()
  let info: ReleaseInfo | null = null
  const zipPath = () => join(tmpdir(), `airlink-daemon-${info?.tag ?? "unknown"}.zip`)

  const steps: Step[] = [
    {
      name: "daemon · resolve latest release",
      state: "pending",
      run: async () => {
        info = await fetchLatestRelease(process.env.AIRLINK_DAEMON_REPO || "airlinklabs/daemon", "daemon.zip")
        return { note: info.tag }
      },
    },
    {
      name: "daemon · download zip",
      state: "pending",
      run: async () => {
        if (!info) throw new Error("release was not resolved - the previous step failed")
        await downloadAsset(info, zipPath())
        return { note: info.digest ? "sha256 ok" : "unverified" }
      },
    },
    {
      name: "daemon · extract",
      state: "pending",
      run: async () => {
        const { rootName, restored } = await stageAndSwap(zipPath(), dir, [".env"])
        pushLog(`extracted ${rootName} -> ${dir}`)
        return { note: restored.includes(".env") ? "kept existing .env" : "fresh install" }
      },
    },
    {
      name: "daemon · write .env",
      state: "pending",
      run: async () => {
        const envPath = join(dir, ".env")
        if (existsSync(envPath)) return { note: "preserved" }
        const examplePath = join(dir, "example.env")
        if (!existsSync(examplePath)) throw new Error(`example.env missing in ${dir} - the release zip may be malformed`)
        const tmp = join(tmpdir(), "airlink-daemon.env")
        await writeFile(tmp, await readFile(examplePath, "utf8"), { mode: 0o644 })
        if ((await run(privCmd(["install", "-m", "644", tmp, envPath]))) !== 0) {
          throw new Error(`failed to write ${envPath} - check permissions`)
        }
        return { note: "fresh (example defaults)" }
      },
    },
    {
      name: "daemon · set permissions",
      state: "pending",
      run: async () => {
        // macOS has no www-data; services run as root there, so root:wheel
        const owner = sys.family === "darwin" ? "root:wheel" : "www-data:www-data"
        if ((await run(privCmd(["chown", "-R", owner, dir]))) !== 0) {
          throw new Error(`failed to chown ${dir} to ${owner} - check permissions`)
        }
        if ((await run(privCmd(["chmod", "-R", "755", dir]))) !== 0) throw new Error(`failed to chmod ${dir}`)
        return { note: sys.family === "darwin" ? "root:wheel" : "www-data" }
      },
    },
    {
      name: "daemon · npm install",
      state: "pending",
      run: async () => {
        if ((await npmPriv(["install"], dir)) !== 0) throw new Error(`npm install failed in ${dir} - see logs above`)
      },
    },
    {
      name: "daemon · build",
      state: "pending",
      run: async () => {
        if ((await npmPriv(["run", "build"], dir)) !== 0) throw new Error("build failed (tsc) - see logs above")
        return { note: "dist/" }
      },
    },
    {
      name: "daemon · native addon (libs)",
      state: "pending",
      run: async () => {
        const libs = join(dir, "libs")
        if ((await privEnv(["npm", "install"], libs)) !== 0) throw new Error(`npm install failed in ${libs} - see logs above`)
        if ((await privEnv(["npm", "rebuild"], libs)) !== 0) throw new Error(`npm rebuild failed in ${libs} - see logs above`)
        const release = join(libs, "build", "Release")
        if (!existsSync(join(release, "rename_at.node")) || !existsSync(join(release, "secure_open.node"))) {
          throw new Error(
            sys.family === "darwin"
              ? "native addon not built - install the Xcode Command Line Tools (xcode-select --install) and re-run"
              : "native addon not built - install build-essential (make, g++, python3) and re-run",
          )
        }
        return { note: "rename_at + secure_open" }
      },
    },
    {
      name: "daemon · install service",
      state: "pending",
      run: async () => ({ note: await installService("daemon", cfg.service, dir) }),
    },
  ]
  return steps
}

export function daemonUninstallSteps(): Step[] {
  const dir = daemonDir()
  return [
    {
      name: "daemon · stop service",
      state: "pending",
      run: async () => ({ note: await removeService("daemon") }),
    },
    {
      name: "daemon · remove files",
      state: "pending",
      run: async () => {
        if ((await run(privCmd(["rm", "-rf", dir]))) !== 0) throw new Error(`failed to remove ${dir} - check permissions`)
        return { note: `removed ${dir}` }
      },
    },
  ]
}

/*============================= panel steps ================================*/
// Install/uninstall steps for /var/www/panel. Fresh installs get an .env built
// from example.env with a generated SESSION_SECRET; existing .env survives
// every reinstall (stageAndSwap preserves it, this step then reports it).

import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Cfg, Step } from "./plan"
import { pushLog } from "./log"
import { downloadAsset, fetchLatestRelease, stageAndSwap, type ReleaseInfo } from "./release"
import { haveCmd, npmPriv, privCmd, run } from "./run"
import { installService, removeService } from "./service"
import { randomHex, sys } from "./sys"

const panelDir = () => process.env.AIRLINK_PANEL_DIR || "/var/www/panel"

/** pure: example.env with SESSION_SECRET replaced by a generated 32-hex secret */
export function buildPanelEnv(example: string, secret: string): string {
  if (/^SESSION_SECRET=.*$/m.test(example)) return example.replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET="${secret}"`)
  const base = example.replace(/\n*$/, "")
  return `${base}\nSESSION_SECRET="${secret}"\n`
}

export async function panelPort(dir: string): Promise<number> {
  try {
    const txt = await readFile(join(dir, ".env"), "utf8")
    const m = txt.match(/^PORT=(\d+)/m)
    if (m) return parseInt(m[1], 10)
  } catch {
    /* no .env (yet) - default below */
  }
  return 3000
}

/** first non-loopback IPv4 - the summary shows a URL the operator can open */
export function firstIp(): string {
  const nets = networkInterfaces()
  for (const list of Object.values(nets)) {
    for (const n of list ?? []) if (!n.internal && n.family === "IPv4") return n.address
  }
  return "127.0.0.1"
}

/** silent probe - the health check retries, its output must not spam the log */
async function probe(url: string): Promise<boolean> {
  try {
    const p = Bun.spawn({ cmd: ["curl", "-s", "-o", "/dev/null", "-m", "2", url], stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    return (await p.exited) === 0
  } catch {
    return false
  }
}

async function writeFreshEnv(dir: string): Promise<void> {
  const envPath = join(dir, ".env")
  const examplePath = join(dir, "example.env")
  if (!existsSync(examplePath)) throw new Error(`example.env missing in ${dir} - the release zip may be malformed`)
  const secret = await randomHex(32)
  const tmp = join(tmpdir(), "airlink-panel.env")
  await writeFile(tmp, buildPanelEnv(await readFile(examplePath, "utf8"), secret), { mode: 0o644 })
  if ((await run(privCmd(["install", "-m", "644", tmp, envPath]))) !== 0) {
    throw new Error(`failed to write ${envPath} - check permissions`)
  }
}

export function panelInstallSteps(cfg: Cfg): Step[] {
  const dir = panelDir()
  // resolve -> download -> extract share the resolved release
  let info: ReleaseInfo | null = null
  const zipPath = () => join(tmpdir(), `airlink-panel-${info?.tag ?? "unknown"}.zip`)

  const svcStep: Step = {
    name: "panel · install service",
    state: "pending",
    run: async () => ({ note: await installService("panel", cfg.service, dir) }),
  }

  const steps: Step[] = [
    {
      name: "panel · resolve latest release",
      state: "pending",
      run: async () => {
        info = await fetchLatestRelease(process.env.AIRLINK_PANEL_REPO || "airlinklabs/panel", "panel.zip")
        return { note: info.tag }
      },
    },
    {
      name: "panel · download zip",
      state: "pending",
      run: async () => {
        if (!info) throw new Error("release was not resolved - the previous step failed")
        await downloadAsset(info, zipPath())
        return { note: info.digest ? "sha256 ok" : "unverified" }
      },
    },
    {
      name: "panel · extract",
      state: "pending",
      run: async () => {
        const { rootName, restored } = await stageAndSwap(zipPath(), dir, [".env"])
        pushLog(`extracted ${rootName} -> ${dir}`)
        return { note: restored.includes(".env") ? "kept existing .env" : "fresh install" }
      },
    },
    {
      name: "panel · write .env",
      state: "pending",
      run: async () => {
        if (existsSync(join(dir, ".env"))) return { note: "preserved" }
        await writeFreshEnv(dir)
        return { note: "fresh" }
      },
    },
    {
      name: "panel · set permissions",
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
      name: "panel · npm install",
      state: "pending",
      run: async () => {
        // dev deps stay installed: npm run build needs tsc + tailwind
        if ((await npmPriv(["install"], dir)) !== 0) throw new Error(`npm install failed in ${dir} - see logs above`)
      },
    },
    {
      name: "panel · database setup",
      state: "pending",
      run: async () => {
        if ((await npmPriv(["exec", "--", "prisma", "generate"], dir)) !== 0) {
          throw new Error("prisma generate failed - it downloads engines and needs network access; see logs above")
        }
        if ((await npmPriv(["exec", "--", "prisma", "db", "push", "--skip-generate"], dir)) !== 0) {
          throw new Error("prisma db push failed - see logs above")
        }
        return { note: "sqlite ok" }
      },
    },
    {
      name: "panel · build",
      state: "pending",
      run: async () => {
        if ((await npmPriv(["run", "build"], dir)) !== 0) throw new Error("build failed (tsc / tailwind) - see logs above")
      },
    },
    svcStep,
    {
      name: "panel · health check",
      state: "pending",
      run: async () => {
        if (svcStep.state === "failed") return { note: "skipped" }
        if (!(await haveCmd("curl"))) {
          pushLog("curl missing - cannot probe the panel")
          return { note: "unreachable" }
        }
        const port = await panelPort(dir)
        for (let i = 0; i < 15; i++) {
          if (await probe(`http://127.0.0.1:${port}/`)) return { note: `ok :${port}` }
          await new Promise((r) => setTimeout(r, 2000))
        }
        pushLog(`panel did not answer on :${port} - check: journalctl -u airlink-panel -f (or pm2 logs airlink-panel)`)
        return { note: "unreachable" }
      },
    },
  ]
  return steps
}

export function panelUninstallSteps(): Step[] {
  const dir = panelDir()
  return [
    {
      name: "panel · stop service",
      state: "pending",
      run: async () => ({ note: await removeService("panel") }),
    },
    {
      name: "panel · remove files",
      state: "pending",
      run: async () => {
        if ((await run(privCmd(["rm", "-rf", dir]))) !== 0) throw new Error(`failed to remove ${dir} - check permissions`)
        return { note: `removed ${dir}` }
      },
    },
  ]
}

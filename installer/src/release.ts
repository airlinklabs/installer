/*============================= release resolution =========================*/
// Latest stable release only: GitHub API first, releases/latest redirect as a
// fallback (rate limits), AIRLINK_*_URL override to skip both.

import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { pushLog } from "./log"
import { capture, privCmd, run, sha256File } from "./run"

export type ReleaseInfo = { repo: string; tag: string; asset: string; url: string; digest: string | null }

type GhAsset = { name?: unknown; browser_download_url?: unknown; digest?: unknown }
type GhRelease = { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: GhAsset[] }

/** pure: validated GitHub /releases/latest payload -> ReleaseInfo (repo unset) */
export function parseReleaseJson(json: unknown, assetName: string): ReleaseInfo {
  const j = json as GhRelease
  if (!j || typeof j !== "object") throw new Error("release response is not a JSON object")
  if (typeof j.tag_name !== "string" || !j.tag_name) throw new Error("release response has no tag_name")
  // the endpoint already excludes both; assert anyway - prereleases must be invisible
  if (j.draft === true) throw new Error("latest release is a draft - refusing to install it")
  if (j.prerelease === true) throw new Error("latest release is a prerelease - this installer only ships stable releases")
  const assets: GhAsset[] = Array.isArray(j.assets) ? j.assets : []
  const a = assets.find((x) => x?.name === assetName)
  if (!a || typeof a.browser_download_url !== "string") {
    throw new Error(`release ${j.tag_name} has no ${assetName} asset - nothing to install`)
  }
  let digest: string | null = null
  if (typeof a.digest === "string") {
    const m = a.digest.match(/^sha256:([0-9a-f]{64})$/i)
    if (m) digest = m[1].toLowerCase()
  }
  return { repo: "", tag: j.tag_name, asset: assetName, url: a.browser_download_url, digest }
}

/** pure: tag from the effective URL of `github.com/<repo>/releases/latest` */
export function tagFromEffectiveUrl(url: string): string | null {
  const m = url.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/tag\/([^/?#]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

export async function fetchLatestRelease(repo: string, assetName: string): Promise<ReleaseInfo> {
  // direct-URL override skips API + redirect entirely (tests/sandbox/offline pin)
  const override =
    repo === "airlinklabs/panel" ? process.env.AIRLINK_PANEL_URL : repo === "airlinklabs/daemon" ? process.env.AIRLINK_DAEMON_URL : undefined
  if (override) return { repo, tag: "override", asset: assetName, url: override, digest: null }

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { "User-Agent": "airlink-installer", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      const info = parseReleaseJson(await res.json(), assetName)
      return { ...info, repo }
    }
    pushLog(`release api responded ${res.status} - falling back to the redirect`)
  } catch (e) {
    pushLog(`release api unreachable: ${(e as Error).message} - falling back to the redirect`)
  }

  // fallback: follow /releases/latest -> .../releases/tag/<tag>, build the asset URL
  const eff = await capture([
    "curl", "-fsSLI", "-o", "/dev/null", "-w", "%{url_effective}",
    `https://github.com/${repo}/releases/latest`,
  ])
  const tag = eff ? tagFromEffectiveUrl(eff.trim()) : null
  if (!tag) {
    const hint = repo === "airlinklabs/panel" ? "AIRLINK_PANEL_URL" : "AIRLINK_DAEMON_URL"
    throw new Error(`cannot resolve the latest release for ${repo} (api rate-limited and the redirect fallback failed) - retry later or set ${hint}`)
  }
  return { repo, tag, asset: assetName, url: `https://github.com/${repo}/releases/download/${tag}/${assetName}`, digest: null }
}

export async function downloadAsset(info: ReleaseInfo, dest: string): Promise<void> {
  const code = await run(["curl", "-fsSL", "--retry", "3", "-o", dest, info.url])
  if (code !== 0) {
    await rm(dest, { force: true })
    throw new Error(`download failed (${info.url}) - check network and re-run`)
  }
  if (info.digest) {
    const got = await sha256File(dest)
    if (got !== info.digest) {
      await rm(dest, { force: true })
      throw new Error(`sha256 mismatch for ${info.asset} (corrupted download) - re-run the installer`)
    }
  }
}

/** pure: staging entries -> the single root dir name, or null when ambiguous */
export function resolveRoot(entries: string[]): string | null {
  return entries.length === 1 ? entries[0] : null
}

/** Stage the zip and swap it in: never extract over a live target (stale files
 *  from a previous release must not survive an upgrade). Preserved files are
 *  backed up before any deletion and restored afterwards. */
export async function stageAndSwap(
  zipPath: string,
  targetDir: string,
  preserve: string[],
): Promise<{ rootName: string; restored: string[] }> {
  const staging = await mkdtemp(join(tmpdir(), "airlink-stage-"))
  const unz = await run(["unzip", "-q", "-o", zipPath, "-d", staging])
  if (unz !== 0) {
    await rm(staging, { recursive: true, force: true })
    throw new Error("unzip failed - is the zip corrupt? re-run the installer to re-download")
  }

  // zips ship exactly one root dir (panel-<sha>/); anything else = staging is root
  const entries = await readdir(staging)
  const one = resolveRoot(entries)
  let rootDir = staging
  if (one) {
    const st = await stat(join(staging, one)).catch(() => null)
    if (st?.isDirectory()) rootDir = join(staging, one)
  }
  const rootName = basename(rootDir)

  // backup preserved files BEFORE any deletion
  const backup = await mkdtemp(join(tmpdir(), "airlink-backup-"))
  const backed: string[] = []
  for (const rel of preserve) {
    const src = join(targetDir, rel)
    if (existsSync(src)) {
      await mkdir(dirname(join(backup, rel)), { recursive: true })
      await cp(src, join(backup, rel), { recursive: true })
      backed.push(rel)
    }
  }

  if ((await run(privCmd(["rm", "-rf", targetDir]))) !== 0) {
    throw new Error(`failed to remove ${targetDir} - check permissions; backup left at ${backup}`)
  }
  if ((await run(privCmd(["mkdir", "-p", targetDir]))) !== 0) {
    throw new Error(`failed to create ${targetDir} - check permissions`)
  }
  if ((await run(privCmd(["cp", "-a", `${rootDir}/.`, `${targetDir}/`]))) !== 0) {
    throw new Error(`failed to copy release files into ${targetDir} - backup left at ${backup}`)
  }

  const restored: string[] = []
  for (const rel of backed) {
    await run(privCmd(["mkdir", "-p", dirname(join(targetDir, rel))]))
    if ((await run(privCmd(["cp", "-a", join(backup, rel), join(targetDir, rel)]))) === 0) restored.push(rel)
    else pushLog(`could not restore ${rel} from ${backup}`)
  }

  await rm(staging, { recursive: true, force: true })
  await rm(backup, { recursive: true, force: true })
  return { rootName, restored }
}

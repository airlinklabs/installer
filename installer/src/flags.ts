/*============================= runtime flags ===============================*/
// Side-effect module: MUST be the first import so this runs before every
// other module body (linking only loads bytes; evaluation order is what
// matters here).
//
// Why: UPX unpacks the binary into anonymous memory. Bun's post-startup
// `hint_source_pages_dont_need` calls madvise(MADV_DONTNEED) on the embedded
// source-text pages assuming they are file-backed - on the next lazy parse
// those pages zero-fill and JSC throws `SyntaxError: Invalid character: '\0'`
// (oven-sh/bun#42515; upstream fix not released yet). The feature flag
// `BUN_FEATURE_FLAG_DISABLE_STANDALONE_MADVISE=1` skips the hint, but bun
// snapshots feature flags before module evaluation, so setting it from
// inside is too late: the value must be present at process start.
//
// So when we ARE a UPX-packed executable, silently re-exec ourselves with
// the flag (stdin/stdout/stderr inherited, exit code propagated). Raw builds
// (dev runs, CI smoke of unpacked assets) detect no UPX magic and start
// exactly once. Cost of the probe: two 64 KiB reads of our own file.

const FLAG = "BUN_FEATURE_FLAG_DISABLE_STANDALONE_MADVISE"
const WINDOW = 64 * 1024

/** pure: does this byte window contain the ASCII "UPX!" packer magic? */
export function hasUpxMagic(bytes: Uint8Array): boolean {
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x55 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x58 && bytes[i + 3] === 0x21) return true
  }
  return false
}

/** probe head and tail of our own executable for the UPX packer magic.
 *  On read failure assume packed: a needless re-exec is harmless, a missed
 *  one would corrupt every lazy parse. */
export async function isUpxPacked(path: string): Promise<boolean> {
  try {
    const f = Bun.file(path)
    if (!(await f.exists())) return true // unreadable -> fail safe, see above
    const size = f.size
    const windows = [
      { start: 0, length: Math.min(WINDOW, size) },
      { start: Math.max(0, size - WINDOW), length: WINDOW },
    ]
    for (const w of windows) {
      const buf = new Uint8Array(await f.slice(w.start, w.start + w.length).arrayBuffer())
      if (hasUpxMagic(buf)) return true
    }
    return false
  } catch {
    return true
  }
}

if (!process.env[FLAG] && (await isUpxPacked(process.execPath))) {
  // argv shape is [execPath, entryPath, ...userArgs] (the runtime inserts the
  // entry path - installer.sh and CI pass only userArgs and parse() reads
  // slice(2)); mirror that: pass userArgs only, the child re-inserts its own.
  const proc = Bun.spawn({
    cmd: [process.execPath, ...process.argv.slice(2)],
    env: { ...(process.env as Record<string, string>), [FLAG]: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    cwd: process.cwd(),
  })
  process.exit(await proc.exited)
}
// uniform from here on: skip the hint in child processes too (harmless on
// unpacked binaries - the source text just stays resident until exit)
process.env[FLAG] ??= "1"

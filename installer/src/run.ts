/*============================= process spawn ==============================*/

import { pushLog } from "./log"

export type RunOpts = { cwd?: string; env?: Record<string, string> }

/** spawn + pump stdout/stderr line-by-line into the log ring buffer */
export async function run(cmd: string[], opts: RunOpts = {}): Promise<number> {
  pushLog(`$ ${cmd.join(" ")}`)
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn({
      cmd,
      cwd: opts.cwd,
      env: { ...(process.env as Record<string, string>), ...opts.env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
  } catch (e) {
    pushLog(`spawn failed: ${cmd[0]}: ${(e as Error).message}`)
    return 127
  }
  const pump = async (stream: ReadableStream<Uint8Array> | null | undefined) => {
    if (!stream) return
    const reader = stream.getReader()
    const td = new TextDecoder()
    let buf = ""
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += td.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) pushLog(line)
      }
    }
    if (buf.trim()) pushLog(buf)
  }
  await Promise.all([
    pump(proc.stdout as ReadableStream<Uint8Array> | undefined),
    pump(proc.stderr as ReadableStream<Uint8Array> | undefined),
  ])
  return await proc.exited
}

/** run without logging - cheap probes (`systemctl is-active`, `id www-data`) */
export async function quiet(cmd: string[], cwd?: string): Promise<number> {
  try {
    return await Bun.spawn({ cmd, cwd, stdout: "ignore", stderr: "ignore", stdin: "ignore" }).exited
  } catch {
    return 127
  }
}

/** capture stdout without logging - `command -v`, `%{url_effective}`, `node -v` */
export async function capture(cmd: string[], cwd?: string): Promise<string | null> {
  try {
    const p = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const out = await new Response(p.stdout as unknown as ReadableStream<Uint8Array>).text()
    return (await p.exited) === 0 ? out : null
  } catch {
    return null
  }
}

/** privileged argv prefix. The shipped binary runs as root and runs commands
 *  directly; the sudo -n path exists for local dev as a normal user (the
 *  operator's own `sudo -v` covers the credential - the TUI never prompts) */
export function privCmd(args: string[]): string[] {
  return process.getuid?.() === 0 ? args : ["sudo", "-n", ...args]
}

export async function sudo(...args: string[]): Promise<number> {
  return run(privCmd(args))
}

/** absolute path of bin or "" - `command -v` is the shell's own lookup, so a
 *  PATH the bootstrap built for us is respected as-is */
export async function whichPath(bin: string): Promise<string> {
  // "$1" keeps the probe a plain argv - no shell interpolation of `bin`
  const out = await capture(["sh", "-c", 'command -v "$1"', "sh", bin])
  if (!out) return ""
  const first = out.split("\n").find((l) => l.trim())
  return first ? first.trim() : ""
}

export async function haveCmd(bin: string): Promise<boolean> {
  return (await whichPath(bin)) !== ""
}

export async function nodeBinDir(): Promise<string> {
  const p = await whichPath("node")
  return p ? p.slice(0, p.lastIndexOf("/")) : ""
}

/** privileged run with node's dir first in PATH - defeats sudo's secure_path
 *  for nvm/asdf installs (spec §8) */
export async function privEnv(args: string[], cwd?: string): Promise<number> {
  const nodeDir = await nodeBinDir()
  const path = nodeDir ? `${nodeDir}:${process.env.PATH ?? ""}` : (process.env.PATH ?? "")
  return run(privCmd(["env", `PATH=${path}`, ...args]), { cwd })
}

export async function npmPriv(args: string[], cwd?: string): Promise<number> {
  return privEnv(["npm", ...args], cwd)
}

export async function sha256File(path: string): Promise<string> {
  const buf = await Bun.file(path).arrayBuffer()
  return new Bun.CryptoHasher("sha256").update(buf).digest("hex")
}

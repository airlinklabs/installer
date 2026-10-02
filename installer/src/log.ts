/*============================= log buffer =================================*/
// Ring buffer feeding the TUI's `logs` pane; in --no-color mode every line is
// echoed straight to stdout instead (the pipe contract: logs never hide).

import type { TextRenderable } from "@opentui/core"
import { stripAnsi, termCols } from "./theme"

export const plainMode = process.argv.includes("--no-color")
export const LOG_CAP = 800
export const logBuf: string[] = []

// pane state stays in this module: ESM live bindings are read-only, so screens
// attach through bindLogPane instead of mutating an exported `let`
let logsText: TextRenderable | null = null
let logViewLines = 20
let logViewWidth = 40
let logDirty = false

/** rows a line occupies under greedy word wrap (mirrors wrapMode: "word") */
function wrappedRows(line: string, width: number): number {
  if (line.length <= width) return 1
  let rows = 0
  let col = 0
  for (const word of line.split(" ")) {
    const wl = word.length
    if (col > 0 && col + 1 + wl <= width) {
      col += 1 + wl
      continue
    }
    if (col > 0) {
      rows++ // close the current row, the word starts fresh
      col = 0
    }
    if (wl <= width) {
      col = wl
      if (col === width) {
        rows++
        col = 0
      }
      continue
    }
    // overlong word: full rows inside it, then a partial remainder
    const full = Math.floor(wl / width)
    rows += full
    col = wl - full * width
  }
  rows += col > 0 ? 1 : 0
  return Math.max(1, rows)
}

export function pushLog(raw: string): void {
  const cols = termCols()
  const line = stripAnsi(raw)
    .replace(/\r/g, "")
    .trimEnd()
    .slice(0, cols * 4)
  logBuf.push(line)
  if (logBuf.length > LOG_CAP) logBuf.splice(0, logBuf.length - LOG_CAP)
  if (plainMode) console.log(line)
  else scheduleLogRender()
}

export function scheduleLogRender(): void {
  if (logDirty || !logsText) return
  logDirty = true
  setTimeout(() => {
    logDirty = false
    if (!logsText) return
    // newest-first, budgeted by WRAPPED rows so the pane never clips what it
    // shows: the newest line always fits, older lines join only while full rows
    // remain - the summary tail (manual steps, commands) is always readable
    const width = Math.max(8, logViewWidth)
    const out: string[] = []
    let used = 0
    for (let i = logBuf.length - 1; i >= 0 && used < logViewLines; i--) {
      const line = logBuf[i]
      const h = wrappedRows(line, width)
      if (out.length > 0 && used + h > logViewLines) break
      out.push(line)
      used += h
    }
    out.reverse()
    logsText.content = out.join("\n")
  }, 50)
}

/** the progress screen attaches its TextRenderable here (and on resize) */
export function bindLogPane(t: TextRenderable | null, viewLines?: number, viewWidth?: number): void {
  logsText = t
  if (viewLines !== undefined) logViewLines = viewLines
  if (viewWidth !== undefined) logViewWidth = viewWidth
  scheduleLogRender()
}

export function setLogViewLines(n: number, width?: number): void {
  logViewLines = n
  if (width !== undefined) logViewWidth = width
  scheduleLogRender()
}

export function resetLogBuf(): void {
  logBuf.length = 0
  if (!plainMode) scheduleLogRender()
}

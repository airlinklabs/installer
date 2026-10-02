/*============================= brand ======================================*/
// Tokyo-night palette + the Airlink wordmark. Own-world inherited from the
// reference installer (Miserable_Xfce): same tokens, Airlink's own banner.

import type { StepState } from "./plan"

export const C = {
  bg: "#1a1b26",
  panel: "#20222e",
  panelAlt: "#252733",
  fg: "#c0caf5",
  dim: "#565f89",
  accent: "#7aa2f7",
  green: "#9ece6a",
  red: "#f7768e",
  yellow: "#e0af68",
} as const

// the Airlink banner - supplied verbatim (ascii-art (1).txt), byte-exact.
// includes the file's own blank margins (rows 1-9 / 23-28); display code goes
// through logoLines() so constrained terminals can drop the margins.
export const LOGO = [
  "                                                   ",
  "                                                   ",
  "                                                   ",
  "                                                   ",
  "                                                   ",
  "                                                   ",
  "                                                   ",
  "                                                   ",
  "                                                   ",
  "                  .-+#%*=..                        ",
  "                  .-#@@@@@%*=:.                    ",
  "                     :*@@@@@@@@*+:.   ..-+*##*=:.  ",
  "                       .=#@@@@@@@@%#+*%@@@@@%%%*:  ",
  "              ...        .-#@@@@@@@@@@@%%%##*=-.   ",
  "          .=*%@@@*=.  ..-+*%@@@@@@@%%%#*==:.       ",
  "     .::-: .=#@@@@@@##@@@@@@@@%%%##+=:.            ",
  "   .:==-:.   .:*%@@@@@@@%%%%##+=-..                ",
  "     .     .::. .-+++==-:.....                     ",
  "      .::-==-:.                                    ",
  "    .-==-:..  ..:-==                               ",
  "     ..    .-===-:..                               ",
  "           :-:..                                   ",
  "                                                   ",
  "                                                   ",
  "                                                   ",
  "                                                   ",
  "                                                   ",
  "                                                   ",
].join("\n")

/** banner lines: full file, or edge-trimmed (13 art rows) for short terminals */
export function logoLines(full: boolean): string[] {
  const lines = LOGO.split("\n")
  if (full) return lines
  let start = 0
  let end = lines.length
  while (start < end && !lines[start].trim()) start++
  while (end > start && !lines[end - 1].trim()) end--
  return lines.slice(start, end)
}

// state is never color-only: the icon carries it, color reinforces it (never emoji)
export const ICONS: Record<StepState, string> = {
  pending: "○",
  running: "▸",
  done: "✓",
  failed: "✗",
  skipped: "⊘",
}
export const COLORS: Record<StepState, string> = {
  pending: C.dim,
  running: C.accent,
  done: C.green,
  failed: C.red,
  skipped: C.yellow,
}
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "")
}

export function termCols(): number {
  // bun/node expose `.columns`; `.cols` is opentui-era folklore and reads undefined
  const s = process.stdout as unknown as { cols?: number; columns?: number }
  return s.cols ?? s.columns ?? 100
}

export function termRows(): number {
  return (process.stdout as unknown as { rows?: number }).rows ?? 24
}

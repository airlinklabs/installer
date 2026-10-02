import { describe, expect, test } from "bun:test"
import { logoLines, LOGO } from "./src/theme"

describe("LOGO banner", () => {
  test("is the 28-line file exactly (51 cols, margins included)", () => {
    const lines = LOGO.split("\n")
    expect(lines.length).toBe(28)
    expect(Math.max(...lines.map((l) => l.length))).toBe(51)
    // blank margins: 9 top, 6 bottom; 13 art rows between
    expect(lines.slice(0, 9).every((l) => !l.trim())).toBe(true)
    expect(lines.slice(22).every((l) => !l.trim())).toBe(true)
    expect(lines.slice(9, 22).every((l) => l.trim().length > 0)).toBe(true)
  })

  test("logoLines(full) serves the file; trimmed drops only the margins", () => {
    expect(logoLines(true)).toEqual(LOGO.split("\n"))
    const trimmed = logoLines(false)
    expect(trimmed.length).toBe(13)
    expect(trimmed).toEqual(LOGO.split("\n").slice(9, 22))
  })
})

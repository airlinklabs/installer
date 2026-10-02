import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasUpxMagic, isUpxPacked } from "./src/flags"

describe("UPX detection (src/flags.ts re-exec probe)", () => {
  test("hasUpxMagic finds the packer magic anywhere in a window", () => {
    const enc = new TextEncoder()
    expect(hasUpxMagic(enc.encode("hello UPX! world"))).toBe(true)
    expect(hasUpxMagic(enc.encode("UPX!"))).toBe(true)
    expect(hasUpxMagic(enc.encode("xUPX"))).toBe(false)
    expect(hasUpxMagic(enc.encode("plain bun binary, no magic"))).toBe(false)
    expect(hasUpxMagic(new Uint8Array(0))).toBe(false)
    // partial match at the very end must not throw or false-positive
    expect(hasUpxMagic(enc.encode("....UPX"))).toBe(false)
  })

  test("isUpxPacked probes head and tail windows of the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flags-test-"))
    try {
      const enc = new TextEncoder()
      const filler = enc.encode("z".repeat(200 * 1024))

      const packedAtTail = join(dir, "tail.bin")
      const tailBytes = new Uint8Array(filler.length + 8)
      tailBytes.set(filler)
      tailBytes.set(enc.encode("UPX!"), filler.length)
      await writeFile(packedAtTail, tailBytes)

      const packedAtHead = join(dir, "head.bin")
      const headBytes = new Uint8Array(8 + filler.length)
      headBytes.set(enc.encode("UPX!"))
      headBytes.set(filler, 8)
      await writeFile(packedAtHead, headBytes)

      const raw = join(dir, "raw.bin")
      await writeFile(raw, filler)

      expect(await isUpxPacked(packedAtTail)).toBe(true)
      expect(await isUpxPacked(packedAtHead)).toBe(true)
      expect(await isUpxPacked(raw)).toBe(false)

      // unreadable path: fail safe toward "packed" (a needless re-exec is
      // harmless, a missed one corrupts every lazy parse)
      expect(await isUpxPacked(join(dir, "missing.bin"))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

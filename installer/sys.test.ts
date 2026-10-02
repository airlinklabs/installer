import { describe, expect, test } from "bun:test"
import { detectSystem, pkgInstallCmd, sys } from "./src/sys"

/** macOS code paths must be verifiable from any platform: detectSystem and
 *  friends read process.platform at call time, so flip it for one test */
async function onDarwin<T>(fn: () => T | Promise<T>): Promise<T> {
  const orig = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { value: "darwin" })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, "platform", orig)
  }
}

describe("macOS support", () => {
  test("detectSystem on darwin: macOS identity, darwin family", async () => {
    const before = { ...sys }
    await onDarwin(async () => {
      await detectSystem()
      expect(sys.family).toBe("darwin")
      expect(sys.id).toBe("macos")
      expect(sys.name.startsWith("macOS")).toBe(true)
    })
    Object.assign(sys, before) // sys is a shared singleton - leave no residue
  })

  test("pkgInstallCmd on darwin installs via brew, never sudo-brew", () => {
    const before = sys.family
    try {
      sys.family = "darwin"
      const cmd = pkgInstallCmd(["curl", "unzip"])
      expect(cmd).toContain("brew")
      expect(cmd).toContain("install")
      expect(cmd.slice(-2)).toEqual(["curl", "unzip"])
      // dev runs are non-root and brew refuses root: brew must run directly
      if (process.getuid?.() !== 0) expect(cmd[0]).not.toBe("sudo")
    } finally {
      sys.family = before
    }
  })

  test("unknown family still fails closed", () => {
    const before = sys.family
    try {
      sys.family = "unknown"
      expect(pkgInstallCmd(["node"])).toEqual(["false"])
    } finally {
      sys.family = before
    }
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { fetchLatestRelease, parseReleaseJson, resolveRoot, tagFromEffectiveUrl } from "./src/release"

const DIGEST_HEX = "ab".repeat(32)
const OK = {
  tag_name: "Beta-2",
  draft: false,
  prerelease: false,
  assets: [
    {
      name: "panel.zip",
      browser_download_url: "https://github.com/airlinklabs/panel/releases/download/Beta-2/panel.zip",
      digest: `sha256:${DIGEST_HEX}`,
    },
  ],
}

describe("parseReleaseJson", () => {
  test("happy path: tag, asset url, digest", () => {
    const i = parseReleaseJson(OK, "panel.zip")
    expect(i.tag).toBe("Beta-2")
    expect(i.asset).toBe("panel.zip")
    expect(i.url).toBe("https://github.com/airlinklabs/panel/releases/download/Beta-2/panel.zip")
    expect(i.digest).toBe(DIGEST_HEX)
  })

  test("rejects prereleases - this installer only ships stable", () => {
    expect(() => parseReleaseJson({ ...OK, prerelease: true }, "panel.zip")).toThrow(/prerelease/)
  })

  test("rejects drafts", () => {
    expect(() => parseReleaseJson({ ...OK, draft: true }, "panel.zip")).toThrow(/draft/)
  })

  test("rejects a missing tag_name", () => {
    expect(() => parseReleaseJson({ ...OK, tag_name: "" }, "panel.zip")).toThrow(/tag_name/)
    expect(() => parseReleaseJson({ assets: [] }, "panel.zip")).toThrow(/tag_name/)
  })

  test("rejects a missing asset (exact name match)", () => {
    expect(() => parseReleaseJson(OK, "daemon.zip")).toThrow(/daemon\.zip/)
  })

  test("absent or malformed digest -> null", () => {
    const noDigest = { ...OK, assets: [{ ...OK.assets[0], digest: undefined }] }
    expect(parseReleaseJson(noDigest, "panel.zip").digest).toBeNull()
    const weird = { ...OK, assets: [{ ...OK.assets[0], digest: "md5:deadbeef" }] }
    expect(parseReleaseJson(weird, "panel.zip").digest).toBeNull()
  })
})

describe("tagFromEffectiveUrl", () => {
  test("resolves the redirect target to a tag", () => {
    expect(tagFromEffectiveUrl("https://github.com/airlinklabs/panel/releases/tag/Beta-2")).toBe("Beta-2")
    expect(tagFromEffectiveUrl("https://github.com/airlinklabs/daemon/releases/tag/beta-2")).toBe("beta-2")
  })

  test("non-tag URLs -> null", () => {
    expect(tagFromEffectiveUrl("https://github.com/airlinklabs/panel/releases/latest")).toBeNull()
    expect(tagFromEffectiveUrl("https://example.com/airlinklabs/panel/releases/tag/Beta-2")).toBeNull()
    expect(tagFromEffectiveUrl("https://github.com/airlinklabs/panel")).toBeNull()
  })
})

describe("fetchLatestRelease", () => {
  afterEach(() => {
    delete process.env.AIRLINK_PANEL_URL
    delete process.env.AIRLINK_DAEMON_URL
  })

  test("AIRLINK_PANEL_URL override skips the API entirely", async () => {
    process.env.AIRLINK_PANEL_URL = "https://example.invalid/panel.zip"
    const i = await fetchLatestRelease("airlinklabs/panel", "panel.zip")
    expect(i.tag).toBe("override")
    expect(i.url).toBe("https://example.invalid/panel.zip")
    expect(i.digest).toBeNull()
  })

  test("each repo reads its own override (no cross-wiring, still no network)", async () => {
    process.env.AIRLINK_PANEL_URL = "https://example.invalid/panel.zip"
    process.env.AIRLINK_DAEMON_URL = "https://example.invalid/daemon.zip"
    const p = await fetchLatestRelease("airlinklabs/panel", "panel.zip")
    const d = await fetchLatestRelease("airlinklabs/daemon", "daemon.zip")
    expect(p.url).toBe("https://example.invalid/panel.zip")
    expect(d.url).toBe("https://example.invalid/daemon.zip")
    expect(p.tag).toBe("override")
    expect(d.tag).toBe("override")
  })
})

describe("resolveRoot", () => {
  test("single entry -> that root", () => {
    expect(resolveRoot(["panel-f28eb37a539e"])).toBe("panel-f28eb37a539e")
  })
  test("multiple entries -> null (staging is the root)", () => {
    expect(resolveRoot(["a", "b"])).toBeNull()
    expect(resolveRoot([])).toBeNull()
  })
})

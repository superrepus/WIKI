import { beforeEach, describe, expect, it, vi } from "vitest"
const io = vi.hoisted(() => ({ files: new Map<string, string>(), write: vi.fn(), size: vi.fn(), mtime: vi.fn(), list: vi.fn(), mkdir: vi.fn(), probe: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: io.probe }))
vi.mock("@/commands/fs", () => ({
  fileExists: async (p: string) => io.files.has(p),
  readFile: async (p: string) => { const s = io.files.get(p); if (s === undefined) throw new Error("ENOENT"); return s },
  createDirectory: async (p: string) => io.mkdir(p),
  writeFileAtomic: async (p: string, content: string) => { await Promise.resolve(); io.write(p, content); io.files.set(p, content) },
  getFileSize: io.size,
  getFileModifiedTime: io.mtime,
  listDirectory: io.list,
}))
import { externalPathKey, externalSourcesPath, ignoreExternalSource, loadExternalSources, lookupExternalSource, normalizeLogicalSourcePath, probeExternalSource, registerExternalRoot, registerExternalSource, registerExternalSources, removeExternalRoot, unregisterExternalSource } from "./external-sources"

const pp = "C:/Knowledge/equipment"
beforeEach(() => { vi.clearAllMocks(); io.files.clear(); io.size.mockReset(); io.mtime.mockReset(); io.list.mockReset(); io.probe.mockReset() })
describe("external sources", () => {
  it("registers references without reading/copying the document and reuses Windows/UNC originals", async () => {
    const actual = await registerExternalSource(pp, "raw/sources/external/manual.pdf", { path: "\\\\SERVER\\Share\\Manual.pdf", kind: "file" })
    expect(actual).toBe("raw/sources/external/manual.pdf")
    expect(await registerExternalSource(pp, "raw/sources/another.pdf", { path: "//server/share/manual.PDF", kind: "file" })).toBe(actual)
    expect(Object.keys((await loadExternalSources(pp)).sources)).toEqual([actual])
    expect(io.size).not.toHaveBeenCalled(); expect(io.list).not.toHaveBeenCalled()
    expect(io.write.mock.calls.every(([p]) => p === externalSourcesPath(pp))).toBe(true)
    expect((await lookupExternalSource(pp, "c:\\knowledge\\equipment\\raw\\sources\\external\\manual.pdf"))?.path).toBe("//server/share/manual.PDF")
  })
  it("serializes concurrent additions and removals without dropping other references or roots", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, n) => registerExternalSource(pp, `raw/sources/${n}.pdf`, { path: `D:/original/${n}.pdf`, kind: "file" })))
    await registerExternalRoot(pp, "origin", { path: "D:/original", kind: "folder", logicalRoot: "raw/sources/original" })
    await Promise.all([unregisterExternalSource(pp, "raw/sources/2.pdf"), registerExternalSource(pp, "raw/sources/new.pdf", { path: "D:/new.pdf", kind: "file" })])
    const registry = await loadExternalSources(pp)
    expect(Object.keys(registry.sources)).toHaveLength(12)
    expect(registry.sources["raw/sources/2.pdf"]).toBeUndefined()
    expect(registry.roots?.origin.path).toBe("D:/original")
    await removeExternalRoot(pp, "origin")
    expect((await loadExternalSources(pp)).roots).toEqual({})
  })
  it("rejects traversal, cross-project aliases, logical collisions, and invalid registries without overwriting them", async () => {
    expect(() => normalizeLogicalSourcePath(pp, "C:/other/raw/sources/x.pdf")).toThrow("belong")
    expect(() => normalizeLogicalSourcePath(pp, "raw/sources/../secrets.json")).toThrow("safe")
    expect(() => externalPathKey("\\\\?\\C:\\secret")).toThrow("absolute")
    await registerExternalSource(pp, "raw/sources/x.pdf", { path: "D:/x.pdf", kind: "file" })
    await expect(registerExternalSource(pp, "raw/sources/X.pdf", { path: "D:/other.pdf", kind: "file" })).rejects.toThrow("another original")
    const before = io.files.get(externalSourcesPath(pp))
    await expect(registerExternalSources(pp, { "raw/sources/good.pdf": { path: "D:/good.pdf", kind: "file" }, "raw/sources/bad.pdf": { path: "D:/elsewhere/bad.pdf", root: "D:/allowed", kind: "folder" } })).rejects.toThrow("outside")
    expect(io.files.get(externalSourcesPath(pp))).toBe(before)
    io.files.set(externalSourcesPath(pp), "{malformed")
    await expect(registerExternalSource(pp, "raw/sources/new.pdf", { path: "D:/new.pdf", kind: "file" })).rejects.toThrow()
    expect(io.files.get(externalSourcesPath(pp))).toBe("{malformed")
  })
  it("distinguishes a deleted file from a disconnected share and preserves source registrations", async () => {
    await registerExternalSource(pp, "raw/sources/manual.pdf", { path: "//server/share/manual.pdf", root: "//server/share", kind: "scheduled" })
    io.probe.mockResolvedValue("unavailable")
    expect((await probeExternalSource(pp, "raw/sources/manual.pdf")).status).toBe("unavailable")
    io.probe.mockResolvedValue("missing")
    expect((await probeExternalSource(pp, "raw/sources/manual.pdf")).status).toBe("missing")
    expect(io.probe).toHaveBeenCalledWith("probe_external_path", { path: "//server/share/manual.pdf" })
    io.probe.mockResolvedValue("present")
    io.size.mockRejectedValue(new Error("Access denied"))
    expect((await probeExternalSource(pp, "raw/sources/manual.pdf")).status).toBe("unavailable")
    io.size.mockResolvedValue(123); io.mtime.mockResolvedValue(456)
    expect(await probeExternalSource(pp, "raw/sources/manual.pdf")).toMatchObject({ status: "present", size: 123, mtime: 456 })
    expect(await lookupExternalSource(pp, "raw/sources/manual.pdf")).not.toBeNull()
  })
  it("user removal records an ignore without deleting the original; explicit re-import clears it", async () => {
    await registerExternalSource(pp, "raw/sources/manual.pdf", { path: "//server/share/manual.pdf", kind: "file" })
    await ignoreExternalSource(pp, "raw/sources/manual.pdf")
    expect(await lookupExternalSource(pp, "raw/sources/manual.pdf")).toBeNull()
    expect((await loadExternalSources(pp)).ignoredPaths).toEqual(["//server/share/manual.pdf"])
    expect(io.write.mock.calls.every(([p]) => p === externalSourcesPath(pp))).toBe(true)
    await registerExternalSource(pp, "raw/sources/manual.pdf", { path: "//SERVER/share/MANUAL.PDF", kind: "file" })
    expect((await loadExternalSources(pp)).ignoredPaths).toEqual([])
  })
})

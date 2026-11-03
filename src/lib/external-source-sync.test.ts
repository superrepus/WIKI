import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode, WikiProject } from "@/types/wiki"

const mocks = vi.hoisted(() => ({
  docs: new Map<string, string>(), originals: new Map<string, { size: number; mtime: number; hash: string }>(),
  trees: new Map<string, FileNode[] | Error>(), probeStatus: new Map<string, string>(),
  copyFile: vi.fn(), deleteFile: vi.fn(), archiveLegacySource: vi.fn(), enqueue: vi.fn(), retract: vi.fn(), discard: vi.fn(), refresh: vi.fn(), inactive: vi.fn(),
}))
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: { path: string }) => {
    if (command !== "probe_external_path") throw Error(`Unexpected native command: ${command}`)
    if (mocks.probeStatus.has(args.path)) return mocks.probeStatus.get(args.path)
    if (mocks.originals.has(args.path)) return "present"
    if ([...mocks.trees.entries()].some(([root, tree]) => args.path.startsWith(`${root}/`) && tree instanceof Error)) return "unavailable"
    return "missing"
  }),
}))
vi.mock("@/commands/fs", () => ({
  copyFile: mocks.copyFile, deleteFile: mocks.deleteFile, archiveLegacySource: mocks.archiveLegacySource,
  createDirectory: vi.fn(async () => {}),
  fileExists: vi.fn(async (path: string) => mocks.docs.has(path)),
  readFile: vi.fn(async (path: string) => { const value = mocks.docs.get(path); if (value === undefined) throw Error("ENOENT"); return value }),
  writeFileAtomic: vi.fn(async (path: string, value: string) => { mocks.docs.set(path, value) }),
  getFileSize: vi.fn(async (path: string) => { const file = mocks.originals.get(path); if (!file) throw Error("ENOENT"); return file.size }),
  getFileModifiedTime: vi.fn(async (path: string) => { const file = mocks.originals.get(path); if (!file) throw Error("ENOENT"); return file.mtime }),
  getFileMd5: vi.fn(async (path: string) => { const file = mocks.originals.get(path); if (!file) throw Error("ENOENT"); return file.hash }),
  listDirectory: vi.fn(async (path: string) => { const tree = mocks.trees.get(path); if (tree instanceof Error) throw tree; if (!tree) throw Error("share is unavailable"); return tree }),
}))
vi.mock("@/lib/source-lifecycle", () => ({
  enqueueSourceIngest: mocks.enqueue, deleteSourceFile: mocks.retract,
  folderContextForSourcePath: () => "fixture",
  isIngestableSourcePath: (path: string) => /\.(md|pdf)$/i.test(path),
}))
vi.mock("@/lib/ingest-queue", () => ({ discardTasksForSources: mocks.discard, enqueueInactiveProjectBatch: mocks.inactive }))
vi.mock("@/lib/project-file-tree-refresh", () => ({ refreshProjectFileTree: mocks.refresh }))
vi.mock("@/lib/project-store", () => ({ loadSourceWatchConfig: async () => ({ includeExtensions: ["md", "pdf"], maxFileSizeMb: 100 }) }))

import { scanRegisteredExternalSources } from "./external-source-sync"
import { externalSourceLogicalPath } from "./external-source-paths"
import { loadExternalSources, registerExternalRoot, registerExternalSource, ignoreExternalSource } from "./external-sources"
import { normalizeSourceWatchConfig } from "./source-watch-config"
import { useWikiStore } from "@/stores/wiki-store"
const project: WikiProject = { id: "external-test-project", path: "/project", name: "Fixture" }
const absolute = (logical: string) => `${project.path}/${logical}`
async function register(path: string, overrides: Record<string, unknown> = {}) {
  const physical = { size: 100, mtime: 1000, hash: "v1" }
  mocks.originals.set(path, physical)
  const root = path.slice(0, path.lastIndexOf("/"))
  if (!mocks.trees.has(root)) mocks.trees.set(root, [])
  const logical = externalSourceLogicalPath(project.path, path)
  return await registerExternalSource(project.path, logical, { path, root, kind: "file", ...physical, pending: false, ...overrides })
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.docs.clear(); mocks.originals.clear(); mocks.trees.clear(); mocks.probeStatus.clear()
  mocks.enqueue.mockResolvedValue(["queued"]); mocks.retract.mockResolvedValue({ deletedWikiPaths: [], rewrittenSourcePages: 0, skippedPages: 0 })
  mocks.archiveLegacySource.mockResolvedValue(undefined); mocks.discard.mockResolvedValue(undefined); mocks.refresh.mockResolvedValue(undefined); mocks.inactive.mockResolvedValue(["inactive"])
  useWikiStore.setState({ project, sourceWatchConfig: normalizeSourceWatchConfig({ includeExtensions: ["md", "pdf"], maxFileSizeMb: 100 }) })
})
afterEach(() => { expect(mocks.copyFile).not.toHaveBeenCalled(); expect(mocks.deleteFile).not.toHaveBeenCalled() })

describe("registered external source synchronization", () => {
  it("queues a newly registered file without copying its contents", async () => {
    const logical = await register("/original/manual.pdf", { pending: true })
    await scanRegisteredExternalSources(project)
    expect(mocks.enqueue).toHaveBeenCalledWith(project, [absolute(logical)], expect.anything())
    expect((await loadExternalSources(project.path)).sources[logical]).toMatchObject({ path: "/original/manual.pdf", pending: false })
    expect([...mocks.docs.keys()]).toEqual(["/project/.llm-wiki/external-sources.json"])
    expect(mocks.retract).not.toHaveBeenCalled()
  })
  it("does nothing for unchanged originals and preserves their existing knowledge", async () => {
    await register("/original/manual.pdf")
    await scanRegisteredExternalSources(project)
    expect(mocks.enqueue).not.toHaveBeenCalled(); expect(mocks.retract).not.toHaveBeenCalled()
  })
  it("retracts a changed original before enqueueing its new version", async () => {
    const logical = await register("/original/manual.pdf")
    mocks.originals.set("/original/manual.pdf", { size: 110, mtime: 2000, hash: "v2" })
    await scanRegisteredExternalSources(project)
    expect(mocks.discard).toHaveBeenCalledWith([absolute(logical)])
    expect(mocks.retract).toHaveBeenCalledWith(project.path, absolute(logical), expect.objectContaining({ fileAlreadyDeleted: true }))
    expect(mocks.retract.mock.invocationCallOrder[0]).toBeLessThan(mocks.enqueue.mock.invocationCallOrder[0])
    expect((await loadExternalSources(project.path)).sources[logical]).toMatchObject({ hash: "v2", pending: false })
  })
  it("updates stat metadata without re-ingesting when only mtime changes", async () => {
    const logical = await register("/original/manual.pdf")
    mocks.originals.set("/original/manual.pdf", { size: 100, mtime: 2000, hash: "v1" })
    await scanRegisteredExternalSources(project)
    expect(mocks.retract).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled()
    expect((await loadExternalSources(project.path)).sources[logical].mtime).toBe(2000)
  })
  it("retracts a truly deleted original only when its parent share is accessible", async () => {
    const logical = await register("/original/manual.pdf")
    mocks.originals.delete("/original/manual.pdf")
    await scanRegisteredExternalSources(project)
    expect(mocks.retract).toHaveBeenCalledWith(project.path, absolute(logical), expect.objectContaining({ fileAlreadyDeleted: true }))
    expect((await loadExternalSources(project.path)).sources[logical]).toBeUndefined()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
  it("retracts files when the entire imported folder is confirmed deleted while its parent share stays online", async () => {
    const root = "//server/share/manuals", path = `${root}/manual.pdf`
    const logical = await register(path, { kind: "folder", root })
    await registerExternalRoot(project.path, "manuals", { path: root, kind: "folder", logicalRoot: "raw/sources/external/manuals" })
    mocks.originals.delete(path)
    mocks.trees.set(root, Error("ENOENT: folder was removed")); mocks.trees.set("//server/share", [])
    mocks.probeStatus.set(path, "missing") // Native probe has independently verified the share is available.
    await scanRegisteredExternalSources(project)
    expect(mocks.retract).toHaveBeenCalledWith(project.path, absolute(logical), expect.objectContaining({ fileAlreadyDeleted: true }))
    expect((await loadExternalSources(project.path)).sources[logical]).toBeUndefined()
  })
  it("retains references and knowledge when the shared folder is unavailable", async () => {
    const logical = await register("//server/share/manual.pdf")
    mocks.originals.delete("//server/share/manual.pdf"); mocks.trees.set("//server/share", Error("network path not found"))
    await scanRegisteredExternalSources(project)
    expect(mocks.retract).not.toHaveBeenCalled(); expect(mocks.discard).not.toHaveBeenCalled()
    expect((await loadExternalSources(project.path)).sources[logical].path).toBe("//server/share/manual.pdf")
  })
  it("discovers new files recursively in a manually imported folder", async () => {
    const root = "/original/folder", path = `${root}/nested/new.md`
    await registerExternalRoot(project.path, "folder", { path: root, kind: "folder", logicalRoot: "raw/sources/external/folder" })
    mocks.originals.set(path, { size: 20, mtime: 1000, hash: "new" })
    mocks.trees.set(root, [{ path: `${root}/nested`, name: "nested", is_dir: true, children: [{ path, name: "new.md", is_dir: false }] }])
    await scanRegisteredExternalSources(project)
    const registry = await loadExternalSources(project.path), entries = Object.entries(registry.sources)
    expect(entries).toHaveLength(1); expect(entries[0][1]).toMatchObject({ path, kind: "folder", relativePath: "nested/new.md", pending: false })
    expect(mocks.enqueue).toHaveBeenCalledWith(project, [absolute(entries[0][0])], expect.anything())
  })
  it("restores manual folder ownership and updates a legacy scheduled source while extra monitors are disabled", async () => {
    const root = "/original/folder", path = `${root}/manual.pdf`
    const logical = await register(path, { kind: "scheduled", root: "/original" })
    await registerExternalRoot(project.path, "manual-folder", { path: root, kind: "folder", logicalRoot: "raw/sources/external/manual-folder" })
    useWikiStore.setState({ scheduledImportConfig: {
      enabled: false, path: root, interval: 5, lastScan: null,
      directories: [{ id: "extra", path: root, enabled: false, interval: 5, lastScan: null }],
    } })
    mocks.originals.set(path, { size: 110, mtime: 2000, hash: "v2" })

    await scanRegisteredExternalSources(project)

    expect((await loadExternalSources(project.path)).sources[logical]).toMatchObject({
      path, root, kind: "folder", relativePath: "manual.pdf", hash: "v2", pending: false,
    })
    expect(mocks.retract).toHaveBeenCalledWith(project.path, absolute(logical), expect.objectContaining({ fileAlreadyDeleted: true }))
    expect(mocks.enqueue).toHaveBeenCalledWith(project, [absolute(logical)], expect.anything())
    expect(mocks.retract.mock.invocationCallOrder[0]).toBeLessThan(mocks.enqueue.mock.invocationCallOrder[0])
  })
  it("does not register or enqueue the same physical file twice across overlapping folder roots", async () => {
    const path = "/original/folder/manual.pdf", logical = await register(path)
    await registerExternalRoot(project.path, "folder", { path: "/original/folder", kind: "folder", logicalRoot: "raw/sources/external/folder" })
    mocks.trees.set("/original/folder", [{ path, name: "manual.pdf", is_dir: false }])
    await scanRegisteredExternalSources(project)
    expect(Object.keys((await loadExternalSources(project.path)).sources)).toEqual([logical])
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
  it("keeps pending registration when no model can enqueue, then retries after a model is configured", async () => {
    const logical = await register("/original/manual.pdf", { pending: true })
    mocks.enqueue.mockResolvedValueOnce([])
    await scanRegisteredExternalSources(project)
    expect((await loadExternalSources(project.path)).sources[logical].pending).toBe(true)
    await scanRegisteredExternalSources(project)
    expect(mocks.enqueue).toHaveBeenCalledTimes(2)
    expect((await loadExternalSources(project.path)).sources[logical].pending).toBe(false)
  })
  it("does not rediscover references explicitly detached by the user", async () => {
    const path = "/original/folder/manual.pdf", logical = await register(path)
    await registerExternalRoot(project.path, "folder", { path: "/original/folder", kind: "folder", logicalRoot: "raw/sources/external/folder" })
    mocks.trees.set("/original/folder", [{ path, name: "manual.pdf", is_dir: false }])
    await ignoreExternalSource(project.path, logical)
    await scanRegisteredExternalSources(project)
    expect(Object.keys((await loadExternalSources(project.path)).sources)).toEqual([])
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
  it("defers deletion and changed-source retraction for inactive projects", async () => {
    const logical = await register("/original/manual.pdf")
    mocks.originals.delete("/original/manual.pdf")
    useWikiStore.setState({ project: { ...project, id: "other" } })
    await scanRegisteredExternalSources(project)
    expect(mocks.retract).not.toHaveBeenCalled()
    expect((await loadExternalSources(project.path)).sources[logical]).toBeDefined()
  })
})

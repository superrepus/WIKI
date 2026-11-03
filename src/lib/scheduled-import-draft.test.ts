import { describe, expect, it } from "vitest"
import type { SettingsDraft } from "@/components/settings/settings-types"
import type { ScheduledImportConfig, ScheduledImportDirectory } from "@/stores/wiki-store"
import { createScheduledImportDirectory, normalizeScheduledImportConfig } from "./scheduled-import-config"
import { appendScheduledImportDraftDirectories, scheduledImportConfigFromDraft, scheduledImportDraftDirectories, scheduledImportSemanticKey, validateScheduledImportDraft } from "./scheduled-import-draft"

type MonitorDraft = Pick<SettingsDraft, "scheduledImportDirectories" | "scheduledImportEnabled" | "scheduledImportPath" | "scheduledImportInterval">
const draft = (directories?: ScheduledImportDirectory[], patch: Partial<MonitorDraft> = {}): MonitorDraft => ({ scheduledImportEnabled: true, scheduledImportPath: "D:/Legacy", scheduledImportInterval: 7, ...(directories === undefined ? {} : { scheduledImportDirectories: directories }), ...patch })
const config = (directories: ScheduledImportDirectory[]): ScheduledImportConfig => normalizeScheduledImportConfig({ directories })

describe("monitor settings drafts", () => {
  it("keeps edited rows independent when the original path is added again", () => {
    const old = createScheduledImportDirectory("D:/Original")
    const edited = { ...old, path: "D:/Edited" }
    const result = appendScheduledImportDraftDirectories([edited], ["D:/Original", "d:\\ORIGINAL\\", "D:/Third"])
    expect(result.duplicates).toBe(1)
    expect(result.addedCount).toBe(2)
    expect(new Set(result.directories.map(row => row.id)).size).toBe(3)
    const changed = result.directories.map(row => row.id === edited.id ? { ...row, enabled: false } : row)
    expect(changed.map(row => row.enabled)).toEqual([false, true, true])
    expect(result.directories.filter(row => row.id !== edited.id).map(row => row.path)).toEqual(["D:/Original", "D:/Third"])
    expect(edited.path).toBe("D:/Edited")
  })

  it("migrates legacy single-directory settings but keeps an explicitly cleared new list empty", () => {
    expect(scheduledImportDraftDirectories(draft())).toMatchObject([{ path: "D:/Legacy", interval: 7, enabled: true }])
    expect(scheduledImportDraftDirectories(draft([]))).toEqual([])
    expect(scheduledImportConfigFromDraft(draft([]), config([createScheduledImportDirectory("D:/Legacy")])).directories).toEqual([])
  })

  it("ignores runtime timestamps when deciding whether to reset settings drafts", () => {
    const original = config([createScheduledImportDirectory("//server/share/docs", { interval: 4, lastScan: 100 })])
    const scanned = config([{ ...original.directories![0], lastScan: 200 }])
    expect(scheduledImportSemanticKey(scanned)).toBe(scheduledImportSemanticKey(original))
    for (const patch of [{ interval: 5 }, { enabled: false }, { path: "//server/share/other" }]) {
      expect(scheduledImportSemanticKey(config([{ ...original.directories![0], ...patch }]))).not.toBe(scheduledImportSemanticKey(original))
    }
  })

  it("keeps fresh background timestamps when saving unsaved settings and resets changed origins", () => {
    const first = createScheduledImportDirectory("D:/Manuals", { lastScan: 100 })
    const second = createScheduledImportDirectory("//server/share/Specs", { lastScan: 150 })
    const current = config([{ ...first, lastScan: 300 }, { ...second, lastScan: 350 }])
    const saved = scheduledImportConfigFromDraft(draft([{ ...first, interval: 10 }, { ...second, path: "//server/share/Other" }]), current)
    expect(saved.directories).toMatchObject([{ path: "D:/Manuals", interval: 10, lastScan: 300 }, { path: "//server/share/Other", lastScan: null }])
    expect(first.lastScan).toBe(100)
  })

  it("allows a paused invalid legacy row without blocking unrelated saves, but checks it on enable", () => {
    const legacy = createScheduledImportDirectory("C:/Library/raw/sources", { enabled: false })
    expect(validateScheduledImportDraft(draft([legacy]), "C:/Library")).toEqual([])
    expect(validateScheduledImportDraft(draft([{ ...legacy, enabled: true }]), "C:/Library").join()).toContain("不能与当前知识库目录相同或互相包含")
    expect(validateScheduledImportDraft(draft([createScheduledImportDirectory("")]), "C:/Library").join()).toContain("请选择原始文件夹")
    expect(validateScheduledImportDraft(draft([legacy, createScheduledImportDirectory("")]), "C:/Library").join()).toContain("额外目录 2")
  })

  it("blocks duplicate paths even when both rows are paused and retains all draft rows for correction", () => {
    const rows = [createScheduledImportDirectory("D:/Manuals", { enabled: false }), createScheduledImportDirectory("d:\\MANUALS\\", { id: "second", enabled: false })]
    expect(scheduledImportDraftDirectories(draft(rows))).toHaveLength(2)
    expect(validateScheduledImportDraft(draft(rows)).join()).toContain("不能重复")
  })
})

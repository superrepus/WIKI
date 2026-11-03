import { describe, expect, it } from "vitest"
import { createScheduledImportDirectory, normalizeScheduledImportConfig, scheduledDirectoryPathKey, validateScheduledImportDirectories } from "./scheduled-import-config"

describe("multiple additional monitor configuration", () => {
  it("migrates one UNC monitor without attaching it to the local project", () => {
    const migrated = normalizeScheduledImportConfig({ enabled: true, path: "\\\\server\\share\\资料", interval: 7, lastScan: 100 }, "C:/Wiki/project")
    expect(migrated.directories).toHaveLength(1)
    expect(migrated.directories?.[0]).toMatchObject({ path: "//server/share/资料", enabled: true, interval: 7, lastScan: 100 })
    expect(normalizeScheduledImportConfig(migrated, "C:/Wiki/project")).toEqual(migrated)
    expect(migrated.directories?.[0].id).toBe(createScheduledImportDirectory("//SERVER/share/资料/").id)
  })
  it("migrates legacy relative locations and keeps disabled monitors disabled", () => {
    const result = normalizeScheduledImportConfig({ enabled: false, path: "legacy", interval: 3, lastScan: null }, "D:\\Wiki\\Project")
    expect(result.directories?.[0]).toMatchObject({ path: "D:/Wiki/Project/legacy", enabled: false, interval: 3 })
    expect(result.enabled).toBe(false)
  })
  it("never resurrects a removed list from leftover legacy fields", () => {
    expect(normalizeScheduledImportConfig({ enabled: true, path: "D:/old", interval: 5, lastScan: 90, directories: [] })).toMatchObject({ enabled: false, path: "", lastScan: null, directories: [] })
  })
  it("keeps independent roots and conservatively consolidates duplicate Windows spellings", () => {
    const a = createScheduledImportDirectory("C:/Input", { enabled: false, interval: 10, lastScan: 10 })
    const same = createScheduledImportDirectory("c:\\INPUT\\", { enabled: true, interval: 2, lastScan: 20 })
    const b = createScheduledImportDirectory("D:/Other", { interval: 15, lastScan: 30 })
    const result = normalizeScheduledImportConfig({ directories: [a, same, b] })
    expect(result.directories).toHaveLength(2)
    expect(result.directories?.[0]).toMatchObject({ path: "C:/Input", enabled: true, interval: 2, lastScan: 20 })
    expect(result.directories?.[1]).toEqual(b)
    expect(result).toMatchObject({ enabled: true, path: "C:/Input", interval: 2, lastScan: 20 })
  })
  it("retains case-sensitive POSIX roots and distinguishes equal ids on different locations", () => {
    const result = normalizeScheduledImportConfig({ directories: [createScheduledImportDirectory("/data/A", { id: "same" }), createScheduledImportDirectory("/data/a", { id: "same" })] })
    expect(result.directories).toHaveLength(2)
    expect(new Set(result.directories?.map(row => row.id)).size).toBe(2)
    expect(scheduledDirectoryPathKey("/data/A")).not.toBe(scheduledDirectoryPathKey("/data/a"))
  })
  it("rejects duplicate, internal, parent and malformed locations before saving", () => {
    const errors = validateScheduledImportDirectories([
      createScheduledImportDirectory("D:/Wiki/Project/input"),
      createScheduledImportDirectory("D:/Wiki"),
      createScheduledImportDirectory("//server/share/docs"),
      createScheduledImportDirectory("\\\\SERVER\\SHARE\\docs"),
      createScheduledImportDirectory("../outside"),
      createScheduledImportDirectory("C:/input/../other"),
    ], "D:/Wiki/Project")
    expect(errors.filter(e => e.includes("互相包含"))).toHaveLength(2)
    expect(errors.some(e => e.includes("已经添加"))).toBe(true)
    expect(errors.filter(e => e.includes("绝对路径"))).toHaveLength(2)
    expect(validateScheduledImportDirectories([createScheduledImportDirectory("\\\\server\\share\\manuals")], "D:/Wiki/Project")).toEqual([])
  })
})

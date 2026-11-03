import { describe, expect, it } from "vitest"
import { manualSourceOrigins, scheduledImportBrowsePath, scheduledImportDisplayPath } from "./scheduled-import-display"

describe("scheduled import source locations", () => {
  it("keeps an unconfigured monitor empty instead of silently choosing the library's sources", () => {
    expect(scheduledImportDisplayPath("", "C:/Library")).toBe("")
  })
  it("preserves a Windows UNC origin without prepending the project", () => {
    expect(scheduledImportDisplayPath("\\\\192.168.3.99\\share\\设备资料", "C:/Library")).toBe("//192.168.3.99/share/设备资料")
    expect(scheduledImportDisplayPath("//server/share/docs", "C:/Library")).toBe("//server/share/docs")
  })
  it("preserves drive and POSIX absolute origins", () => {
    expect(scheduledImportDisplayPath("D:\\Documents\\Manuals", "C:/Library")).toBe("D:/Documents/Manuals")
    expect(scheduledImportDisplayPath("/mnt/docs", "/home/library")).toBe("/mnt/docs")
  })
  it("expands only a saved legacy relative path", () => {
    expect(scheduledImportDisplayPath("raw\\sources", "C:\\Library\\")).toBe("C:/Library/raw/sources")
    expect(scheduledImportDisplayPath("legacy/docs")).toBe("legacy/docs")
  })
  it("shows real manual roots and original file paths, counts current references and excludes scheduled-only roots", () => {
    expect(manualSourceOrigins({ version: 1, roots: { root: { path: "C:/Desktop/Manuals", kind: "folder", logicalRoot: "raw/sources/external/opaque" } }, sources: {
      "raw/sources/external/opaque/a.pdf": { path: "C:/Desktop/Manuals/a.pdf", root: "C:/Desktop/Manuals", kind: "folder" },
      "raw/sources/external/opaque/sub/b.pdf": { path: "C:/Desktop/Manuals/sub/b.pdf", root: "C:/Desktop/Manuals", kind: "folder" },
      "raw/sources/external/other/c.pdf": { path: "D:/Other/c.pdf", kind: "file" },
      "raw/sources/scheduled-import/d.pdf": { path: "//server/share/d.pdf", kind: "scheduled" },
    } })).toEqual([
      { kind: "folder", path: "C:/Desktop/Manuals", count: 2 },
      { kind: "file", path: "D:/Other/c.pdf", count: 1 },
    ])
  })
  it("counts sources by physical manual-root membership even when legacy scheduled scans changed their kind", () => {
    expect(manualSourceOrigins({ version: 1, roots: { manual: { path: "D:/Manuals", kind: "folder", logicalRoot: "raw/sources/external/manual" } }, sources: {
      a: { path: "d:/MANUALS/sub/a.pdf", root: "d:/MANUALS/sub", kind: "scheduled" },
      b: { path: "D:/Manuals/b.pdf", kind: "file" },
      c: { path: "D:/Manuals-other/c.pdf", kind: "scheduled" },
      d: { path: "D:/Other/d.pdf", kind: "file" },
    } })).toEqual([{ kind: "folder", path: "D:/Manuals", count: 2 }, { kind: "file", path: "D:/Other/d.pdf", count: 1 }])
  })
  it("retains a watched empty folder and can recover manual folder grouping from source entries", () => {
    expect(manualSourceOrigins({ version: 1, roots: { empty: { path: "D:/Empty", kind: "folder", logicalRoot: "raw/sources/external/empty" } }, sources: {
      "raw/sources/external/a.pdf": { path: "D:/Existing/a.pdf", root: "D:/Existing", kind: "folder" },
    } })).toEqual([{ kind: "folder", path: "D:/Empty", count: 0 }, { kind: "folder", path: "D:/Existing", count: 1 }])
  })
  it("opens the picker at the real configured origin or manual folder without inventing a saved monitor", () => {
    const origins = [{ kind: "folder" as const, path: "C:/Desktop/Manuals", count: 14 }]
    expect(scheduledImportBrowsePath("C:/Library", "\\\\server\\share\\docs", origins)).toBe("//server/share/docs")
    expect(scheduledImportBrowsePath("C:/Library", "", origins)).toBe("C:/Desktop/Manuals")
    expect(scheduledImportBrowsePath("C:/Library", "C:/Library/raw/sources", origins)).toBe("C:/Desktop/Manuals")
    expect(scheduledImportBrowsePath("C:/Library", "", [])).toBeUndefined()
  })
})

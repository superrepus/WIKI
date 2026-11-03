import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: mocks.open }))
import { openSourceOriginal, resolveSourcePath } from "./source-file-access"
beforeEach(() => { vi.clearAllMocks(); mocks.invoke.mockReset() })
it("opens the registered original returned by native resolution, without reading the file into the renderer", async () => {
  mocks.invoke.mockResolvedValue("//server/share/manual.pdf")
  await openSourceOriginal("C:/library/raw/sources/manual.pdf")
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("resolve_source_path", { path: "C:/library/raw/sources/manual.pdf" })
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith("//server/share/manual.pdf")
})
it("preserves ordinary native-resolved local project files", async () => {
  mocks.invoke.mockResolvedValue("C:/library/wiki/report.html")
  expect(await resolveSourcePath("C:/library/wiki/report.html")).toBe("C:/library/wiki/report.html")
})
it("never falls back to an unverified physical path when native registration/permissions reject it", async () => {
  mocks.invoke.mockRejectedValue(new Error("Source registration is invalid"))
  await expect(openSourceOriginal("C:/library/raw/sources/manual.pdf")).rejects.toThrow("invalid")
  expect(mocks.open).not.toHaveBeenCalled()
})

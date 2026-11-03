import { beforeEach, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { useUpdateStore } from "@/stores/update-store"
const install = vi.hoisted(() => vi.fn())
vi.mock("@/lib/update-install", () => ({ installAvailableUpdate: install }))
// SSR normally reads Zustand's initial snapshot; exercise the current UI state here.
vi.mock("@/stores/update-store", async importOriginal => {
  const actual = await importOriginal<typeof import("@/stores/update-store")>()
  return { ...actual, useUpdateStore: Object.assign((selector: (state: ReturnType<typeof actual.useUpdateStore.getState>) => unknown) => selector(actual.useUpdateStore.getState()), actual.useUpdateStore) }
})
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
import { UpdateActions, UpdateOperationOverlay } from "./update-actions"
beforeEach(() => useUpdateStore.getState().setInstall("idle"))
it("offers the update-and-restart action for a discovered release", () => {
  const html = renderToStaticMarkup(<UpdateActions version="v1.1.0"/>)
  expect(html).toContain("updates.install")
  expect(html).not.toContain("disabled=")
})
it("disables duplicate clicks and shows the current preparation stage", () => {
  useUpdateStore.getState().setInstall("preparing")
  const html = renderToStaticMarkup(<UpdateActions version="v1.1.0"/>)
  expect(html).toContain("updates.preparing")
  expect(html).toContain("disabled=")
  expect(renderToStaticMarkup(<UpdateOperationOverlay/>)).toBe("")
})
it("blocks edits during safe saving and shows a useful failure rather than native exception text", () => {
  useUpdateStore.getState().setInstall("saving")
  expect(renderToStaticMarkup(<UpdateOperationOverlay/>)).toContain('aria-modal="true"')
  useUpdateStore.getState().setInstall("error", "save")
  const html = renderToStaticMarkup(<UpdateActions version="v1.1.0"/>)
  expect(html).toContain('role="alert"')
  expect(html).toContain("updates.errors.save")
})

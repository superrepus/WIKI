import { expect, it } from "vitest"
import { markUpdateSettingsDirty, hasUnsavedUpdateSettings, registerUpdateSaveBarrier, flushUpdateSaveBarriers } from "./update-save-barrier"

it("keeps unsaved settings protected until every owner saves or closes", () => {
  const a = {}, b = {}
  markUpdateSettingsDirty(a, true); markUpdateSettingsDirty(b, true)
  markUpdateSettingsDirty(a, false)
  expect(hasUnsavedUpdateSettings()).toBe(true)
  markUpdateSettingsDirty(b, false)
  expect(hasUnsavedUpdateSettings()).toBe(false)
})

it("propagates an editor flush failure instead of declaring data safe for restart", async () => {
  const unregister = registerUpdateSaveBarrier(async () => { throw new Error("document not saved") })
  try { await expect(flushUpdateSaveBarriers()).rejects.toThrow("document not saved") }
  finally { unregister() }
  await expect(flushUpdateSaveBarriers()).resolves.toBeUndefined()
})

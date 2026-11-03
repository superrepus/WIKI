import { expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { SettingsSaveStatus } from "./settings-save-status"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key === "settings.saveFailed" ? "设置保存失败" : key }) }))

it("shows actionable local validation details in the actual save bar status", () => {
  const html = renderToStaticMarkup(<SettingsSaveStatus validationError="额外监控目录不能重复：D:/Manuals" saveError={null} saved={false} />)
  expect(html).toContain("额外监控目录不能重复：D:/Manuals")
  expect(html).toContain('role="alert"')
})

it("does not expose raw runtime error text in the save bar", () => {
  const html = renderToStaticMarkup(<SettingsSaveStatus validationError={null} saveError="request failed: sensitive-runtime-error" saved={false} />)
  expect(html).toContain("设置保存失败")
  expect(html).not.toContain("sensitive-runtime-error")
})

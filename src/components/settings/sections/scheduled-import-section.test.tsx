import { expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { SettingsDraft } from "../settings-types"
import type { ScheduledImportDirectory } from "@/stores/wiki-store"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }) }))
vi.mock("@/stores/wiki-store", () => ({ useWikiStore: (select: (state: unknown) => unknown) => select({ project: { id: "test", path: "C:/Library" }, scheduledImportConfig: { enabled: false, path: "", interval: 1, lastScan: null, directories: [] }, dataVersion: 0 }) }))
vi.mock("@/lib/scheduled-import", () => ({ scanAndImport: vi.fn() }))
vi.mock("@/lib/external-source-sync", () => ({ scanRegisteredExternalSources: vi.fn() }))
import { ExtraMonitorDirectoryList, ManualSourceOriginList, ScheduledImportSection } from "./scheduled-import-section"

const draft = (patch: Partial<SettingsDraft> = {}) => ({ scheduledImportEnabled: false, scheduledImportPath: "", scheduledImportInterval: 1, scheduledImportDirectories: [], ...patch }) as SettingsDraft
const callbacks = { onChange: vi.fn(), onBrowse: vi.fn(), onScan: vi.fn(), onRemove: vi.fn() }
const row = (id: string, path: string, patch: Partial<ScheduledImportDirectory> = {}): ScheduledImportDirectory => ({ id, path, enabled: true, interval: 1, lastScan: null, ...patch })

it("explains always-on manual monitoring without a misleading global opt-in checkbox", () => {
  const html = renderToStaticMarkup(<ScheduledImportSection draft={draft()} setDraft={() => {}} />)
  expect(html).toContain("来源与自动同步")
  expect(html).toContain("手动来源：自动监控始终开启")
  expect(html).toContain("约每分钟")
  expect(html).toContain("无需额外勾选开关")
  expect(html).toContain("尚未添加额外监控目录。上方手动来源仍会自动监控。")
  expect(html).toContain("添加监控目录")
  expect(html).not.toContain('type="checkbox"')
  expect(html).not.toContain('value="C:/Library/raw/sources"')
  expect(html).toContain("当前项目暂无手动登记的外部来源")
})

it("renders multiple independent local and shared monitors, periods and runtime status", () => {
  const directories = [row("a", "D:/Manuals", { interval: 2, lastScan: 1700000000000 }), row("b", "//server/share/specifications", { enabled: false, interval: 15 })]
  const html = renderToStaticMarkup(<ExtraMonitorDirectoryList directories={directories} savedDirectories={directories} projectPath="C:/Library" {...callbacks} />)
  expect(html).toContain('aria-label="额外目录 1"')
  expect(html).toContain('aria-label="额外目录 2"')
  expect(html).toContain('value="D:/Manuals"')
  expect(html).toContain('value="//server/share/specifications"')
  expect(html).toContain('value="2"')
  expect(html).toContain('value="15"')
  expect(html).toContain("自动监控已启用")
  expect(html).toContain("自动监控已暂停")
  expect(html).toContain(new Date(1700000000000).toLocaleString())
  expect(html).toContain("尚未扫描")
  expect(html.match(/立即扫描/g)).toHaveLength(2)
  expect(html).toContain("只取消此条监控，保留资料")
})

it("requires saving edited origins before scanning and does not show the old origin's timestamp", () => {
  const saved = row("a", "D:/Before", { lastScan: 1700000000000 })
  const html = renderToStaticMarkup(<ExtraMonitorDirectoryList directories={[{ ...saved, path: "D:/After" }]} savedDirectories={[saved]} projectPath="C:/Library" {...callbacks} />)
  expect(html).toContain("待保存")
  expect(html).toContain("保存后可扫描")
  expect(html).toContain('disabled=""')
  expect(html).toContain("尚未扫描")
  expect(html).not.toContain(new Date(1700000000000).toLocaleString())
})

it("shows invalid legacy monitor as paused with a repair message", () => {
  const directories = [row("legacy", "C:/Library/raw/sources", { enabled: false })]
  const html = renderToStaticMarkup(<ExtraMonitorDirectoryList directories={directories} savedDirectories={directories} projectPath="C:/Library" {...callbacks} />)
  expect(html).toContain("自动监控已暂停")
  expect(html).toContain("启用前请修正")
  expect(html).toContain('role="alert"')
})

it("shows real original paths and makes clear they already include new files under folder roots", () => {
  const html = renderToStaticMarkup(<ManualSourceOriginList origins={[{ kind: "folder", path: "C:/Desktop/Real folder", count: 14 }]} />)
  expect(html).toContain("C:/Desktop/Real folder")
  expect(html).toContain("已登记 14 个文件")
  expect(html).toContain("已登记 1 处原始位置 · 始终自动监控")
  expect(html).toContain("文件夹会检查子目录和新增文件")
  expect(html).toContain("不需要重复添加为额外目录")
  expect(html).toContain("不代表原文件已复制")
})

it("limits the initial original-path list to ten and offers expansion", () => {
  const html = renderToStaticMarkup(<ManualSourceOriginList origins={Array.from({ length: 12 }, (_, i) => ({ kind: "file", path: `D:/Original/file-${i}.pdf`, count: 1 }))} />)
  expect(html).toContain("D:/Original/file-9.pdf")
  expect(html).not.toContain("D:/Original/file-10.pdf")
  expect(html).toContain("查看全部 12 处")
})

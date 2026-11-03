import { beforeEach, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
const context = vi.hoisted(() => ({ state: { selectedFile: null as string | null, project: { id: "test", name: "Library", path: "C:/Library" }, fileContent: "# Original text", previewContentPath: null, externalPreview: null, previewBackStack: [], previewForwardStack: [], setFileContent: () => {}, closePreview: () => {}, navigatePreviewBack: () => {}, navigatePreviewForward: () => {} } }))
vi.mock("@/stores/wiki-store", () => ({ useWikiStore: (select: (state: typeof context.state) => unknown) => select(context.state) }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/components/editor/wiki-editor", () => ({ WikiEditor: () => <div data-testid="editable-wiki-editor" /> }))
vi.mock("@/components/editor/file-preview", () => ({ FilePreview: ({ readOnly }: { readOnly?: boolean }) => <div data-testid={readOnly ? "readonly-file-preview" : "file-preview"} /> }))
import { PreviewPanel } from "./preview-panel"
beforeEach(() => { context.state.selectedFile = null })
it("never mounts an editable Markdown editor while an original-source registration is still being checked", () => {
  context.state.selectedFile = "C:/Library/raw/sources/external/manual.md"
  const html = renderToStaticMarkup(<PreviewPanel />)
  expect(html).toContain("readonly-file-preview")
  expect(html).not.toContain("editable-wiki-editor")
})
it("keeps ordinary Wiki pages editable without waiting on original-source registration", () => {
  context.state.selectedFile = "C:/Library/wiki/entities/product.md"
  const html = renderToStaticMarkup(<PreviewPanel />)
  expect(html).toContain("editable-wiki-editor")
  expect(html).not.toContain("readonly-file-preview")
})

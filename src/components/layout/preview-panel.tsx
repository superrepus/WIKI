import { useEffect, useCallback, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import { KnowledgeEmptyState } from "@/components/brand/knowledge-empty-state"
import { readFile, writeFile } from "@/commands/fs"
import { getFileCategory, isBinary, isExtractedTextPreviewFile } from "@/lib/file-types"
import { WikiEditor } from "@/components/editor/wiki-editor"
import { FilePreview } from "@/components/editor/file-preview"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { lookupExternalSource, type ExternalSource } from "@/lib/external-sources"
import { openSourceOriginal } from "@/lib/source-file-access"
import { registerUpdateSaveBarrier } from "@/lib/update-save-barrier"

export function PreviewPanel() {
  const { t } = useTranslation()
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const projectPath = useWikiStore((s) => s.project?.path ?? null)
  const fileContent = useWikiStore((s) => s.fileContent)
  const previewContentPath = useWikiStore((s) => s.previewContentPath)
  const externalPreview = useWikiStore((s) => s.externalPreview)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const closePreview = useWikiStore((s) => s.closePreview)
  const previewBackStack = useWikiStore((s) => s.previewBackStack)
  const previewForwardStack = useWikiStore((s) => s.previewForwardStack)
  const navigatePreviewBack = useWikiStore((s) => s.navigatePreviewBack)
  const navigatePreviewForward = useWikiStore((s) => s.navigatePreviewForward)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<{ path: string; markdown: string } | null>(null)
  const writingRef = useRef<Promise<void>>(Promise.resolve())
  // Snapshot of what was most recently loaded from disk. Milkdown re-emits
  // `markdownUpdated` on initial parse (before the user types anything),
  // which used to trigger an auto-save that could write back a placeholder
  // marker if read_file had returned one for a missing/locked file. We
  // skip save when the incoming markdown equals the last-loaded content.
  const lastLoadedRef = useRef<string>("")
  const [sourceReference, setSourceReference] = useState<{ selected: string; project: string; entry: ExternalSource | null; error: string | null } | null>(null)
  const needsSourceLookup = Boolean(selectedFile && projectPath && normalizePath(selectedFile).toLowerCase().startsWith(`${normalizePath(projectPath).replace(/\/+$/, "").toLowerCase()}/raw/sources/`))
  const sourceChecked = sourceReference?.selected === selectedFile && sourceReference?.project === projectPath
  const registeredSource = sourceChecked ? sourceReference.entry : null
  // Fail closed while a raw-source identity is being checked: never mount an
  // editable Markdown surface for an external original, even for one frame.
  const sourceReadOnly = needsSourceLookup && (!sourceChecked || Boolean(registeredSource) || Boolean(sourceReference?.error))
  useEffect(() => {
    let cancelled = false
    if (!needsSourceLookup || !selectedFile || !projectPath) return
    void lookupExternalSource(projectPath, selectedFile).then(
      entry => { if (!cancelled) setSourceReference({ selected: selectedFile, project: projectPath, entry, error: null }) },
      error => { if (!cancelled) setSourceReference({ selected: selectedFile, project: projectPath, entry: null, error: String(error) }) },
    )
    return () => { cancelled = true }
  }, [needsSourceLookup, selectedFile, projectPath])

  useEffect(() => {
    let cancelled = false
    if (!selectedFile) {
      setFileContent("")
      lastLoadedRef.current = ""
      return
    }
    if (previewContentPath === selectedFile) {
      lastLoadedRef.current = fileContent
      return
    }
    if (externalPreview?.path === selectedFile) {
      lastLoadedRef.current = fileContent
      return
    }

    const category = getFileCategory(selectedFile)

    if (isBinary(category) && !isExtractedTextPreviewFile(selectedFile)) {
      setFileContent("")
      lastLoadedRef.current = ""
      return
    }

    readFile(selectedFile)
      .then((content) => {
        if (cancelled) return
        lastLoadedRef.current = content
        setFileContent(content)
      })
      .catch((err) => {
        if (cancelled) return
        lastLoadedRef.current = ""
        setFileContent(`Error loading file: ${err}`)
      })
    return () => {
      cancelled = true
    }
  }, [selectedFile, previewContentPath, externalPreview, setFileContent])

  const writeNow = useCallback((path: string, markdown: string, syncStore = false) => {
    const writing = writingRef.current.catch(() => {}).then(() => writeFile(path, markdown))
      .then(() => {
        lastLoadedRef.current = markdown
        if (syncStore) setFileContent(markdown)
        if (pendingSaveRef.current?.path === path && pendingSaveRef.current.markdown === markdown) pendingSaveRef.current = null
      })
    writingRef.current = writing
    void writing.catch((err) => console.error("Failed to save:", err))
    return writing
  }, [setFileContent])

  useEffect(() => registerUpdateSaveBarrier(async () => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    const pending = pendingSaveRef.current
    if (pending) await writeNow(pending.path, pending.markdown, true)
    else await writingRef.current
  }), [writeNow])

  const handleSave = useCallback(
    (markdown: string, options?: { immediate?: boolean }) => {
      if (!selectedFile || sourceReadOnly) return
      // Ignore no-op saves from the editor's initial re-emit. Only write
      // when the user has actually changed the content relative to the
      // last disk read.
      if (markdown === lastLoadedRef.current) return
      pendingSaveRef.current = { path: selectedFile, markdown }
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (options?.immediate) {
        setFileContent(markdown)
        writeNow(selectedFile, markdown, true)
        return
      }
      saveTimerRef.current = setTimeout(() => {
        writeNow(selectedFile, markdown, true)
      }, 1000)
    },
    [selectedFile, sourceReadOnly, setFileContent, writeNow]
  )

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  if (!selectedFile) {
    return (
      <KnowledgeEmptyState />
    )
  }

  const category = getFileCategory(selectedFile)
  const fileName = externalPreview?.path === selectedFile
    ? externalPreview.title
    : getFileName(selectedFile)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1">
          <button type="button" onClick={navigatePreviewBack} disabled={previewBackStack.length === 0} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30" title={t("preview.back")} aria-label={t("preview.back")}>
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={navigatePreviewForward} disabled={previewForwardStack.length === 0} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30" title={t("preview.forward")} aria-label={t("preview.forward")}>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
          <span className="truncate text-xs text-muted-foreground" title={selectedFile}>{fileName}</span>
        </div>
        <button onClick={closePreview} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent" title={t("common.close")} aria-label={t("common.close")}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {registeredSource && <div className="border-b bg-primary/5 px-3 py-2 text-xs"><div className="font-medium text-primary">外部来源 · 只读</div><div className="mt-1 break-all text-muted-foreground" title={registeredSource.path}>{registeredSource.path}</div><button type="button" className="mt-1 underline" onClick={() => void openSourceOriginal(selectedFile)}>打开原始文件</button></div>}
      {needsSourceLookup && sourceChecked && sourceReference?.error && <div role="alert" className="border-b px-3 py-2 text-xs text-destructive">无法确认来源登记，暂以只读方式展示：{sourceReference.error}</div>}
      <div className="flex-1 min-w-0 overflow-auto">
        {externalPreview?.path === selectedFile ? (
          <ExternalReferencePreview
            source={externalPreview.source}
            title={externalPreview.title}
            path={externalPreview.url}
            snippet={externalPreview.snippet || fileContent}
          />
        ) : category === "markdown" && !sourceReadOnly ? (
          <WikiEditor
            key={selectedFile}
            content={fileContent}
            onSave={handleSave}
            filePath={selectedFile}
          />
        ) : (
          <FilePreview
            key={selectedFile}
            filePath={selectedFile}
            textContent={fileContent}
            readOnly={sourceReadOnly}
          />
        )}
      </div>
    </div>
  )
}

function ExternalReferencePreview({
  source,
  title,
  path,
  snippet,
}: {
  source: string
  title: string
  path: string
  snippet: string
}) {
  return (
    <div className="flex h-full flex-col overflow-auto p-6">
      <div className="mb-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
            {source}
          </span>
          <h3 className="truncate text-sm font-medium" title={title}>{title}</h3>
        </div>
        <div className="break-all rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {path}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60 bg-background p-4">
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">
          {snippet || "(No preview fragment returned.)"}
        </pre>
      </div>
    </div>
  )
}

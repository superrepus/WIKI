import { useTranslation } from "react-i18next"
import { Download, LoaderCircle } from "lucide-react"
import { useUpdateStore } from "@/stores/update-store"
import { installAvailableUpdate } from "@/lib/update-install"

export function UpdateActions({ version }: { version?: string }) {
  const { t } = useTranslation()
  const stage = useUpdateStore(s => s.installStage)
  const error = useUpdateStore(s => s.installError)
  const busy = ["preparing", "saving", "restarting"].includes(stage)
  return <div className="flex flex-wrap items-center gap-2">
    {version && <button type="button" disabled={busy} onClick={() => void installAvailableUpdate(version)} className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm disabled:opacity-70">
      {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin"/> : <Download className="h-3.5 w-3.5"/>}
      {t(`updates.${busy ? stage : "install"}`)}
    </button>}
    {stage === "error" && <span role="alert" className="text-xs text-destructive">{t(`updates.errors.${error ?? "download"}`)}</span>}
  </div>
}

/** Block edits only during the short safe-save/restart handoff, not while downloading. */
export function UpdateOperationOverlay() {
  const { t } = useTranslation()
  const stage = useUpdateStore(s => s.installStage)
  if (stage !== "saving" && stage !== "restarting") return null
  return <div role="dialog" aria-modal="true" aria-label={t(`updates.${stage}`)} className="fixed inset-0 z-[200] flex items-center justify-center bg-background/80 backdrop-blur-sm">
    <div className="mx-5 max-w-md rounded-xl border bg-card p-6 shadow-lg"><div className="flex items-center gap-3 font-medium"><LoaderCircle className="h-5 w-5 animate-spin"/>{t(`updates.${stage}`)}</div><p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t("updates.preserve")}</p></div>
  </div>
}

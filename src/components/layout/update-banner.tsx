import { Sparkles, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useUpdateStore, shouldShowUpdateBanner } from "@/stores/update-store"
import { persistUpdateState } from "@/lib/update-runtime"
import { UpdateActions, UpdateOperationOverlay } from "./update-actions"

export function UpdateBanner() {
  const { t } = useTranslation()
  const visible = useUpdateStore(s => shouldShowUpdateBanner(s))
  const result = useUpdateStore(s => s.lastResult)
  const stage = useUpdateStore(s => s.installStage)
  const available = result?.kind === "available" ? result : null
  const show = visible || stage !== "idle"
  const dismiss = () => {
    if (available) useUpdateStore.getState().setDismissed(available.remote)
    if (stage === "error") useUpdateStore.getState().setInstall("idle")
    void persistUpdateState().catch(() => {})
  }
  return <>
    {show && <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-primary/20 bg-primary/5 px-4 py-2 text-sm">
      <div className="flex min-w-0 flex-1 items-center gap-2"><Sparkles className="h-4 w-4 shrink-0 text-primary"/><span className="truncate font-medium">{available ? t("updateBanner.message", { version: available.remote.replace(/^v/, "") }) : t("updates.status")}</span></div>
      <UpdateActions version={available?.remote}/>
      {["idle", "error"].includes(stage) && <button type="button" onClick={dismiss} aria-label={t("updateBanner.dismiss")} className="rounded p-1 text-muted-foreground hover:bg-accent"><X className="h-4 w-4"/></button>}
    </div>}
    <UpdateOperationOverlay/>
  </>
}

import { useTranslation } from "react-i18next"

interface Props {
  validationError: string | null
  saveError: string | null
  saved: boolean
}

/** Validation text is local and actionable; runtime errors retain the generic message. */
export function SettingsSaveStatus({ validationError, saveError, saved }: Props) {
  const { t } = useTranslation()
  const error = Boolean(validationError || saveError)
  return <p role={error ? "alert" : undefined} className={`min-w-0 break-words text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>
    {validationError || (saveError ? t("settings.saveFailed") : saved ? t("settings.savedTick") : t("settings.changeHint"))}
  </p>
}

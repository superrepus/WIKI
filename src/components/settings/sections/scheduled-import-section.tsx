import { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { open } from "@tauri-apps/plugin-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Folder, Play, RefreshCw, Plus, Trash2, ShieldCheck, Clock } from "lucide-react"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import { useWikiStore, type ScheduledImportDirectory } from "@/stores/wiki-store"
import { loadExternalSources } from "@/lib/external-sources"
import { scanRegisteredExternalSources } from "@/lib/external-source-sync"
import { manualSourceOrigins, scheduledImportBrowsePath, type ManualSourceOrigin } from "@/lib/scheduled-import-display"
import { normalizeScheduledImportConfig, scheduledDirectoryPathKey, validateScheduledImportDirectories } from "@/lib/scheduled-import-config"
import { appendScheduledImportDraftDirectories, scheduledImportDraftDirectories } from "@/lib/scheduled-import-draft"
import { scanAndImport } from "@/lib/scheduled-import"

interface Props { draft: SettingsDraft; setDraft: DraftSetter }
const sameDirectorySettings = (a: ScheduledImportDirectory, b: ScheduledImportDirectory) => a.id === b.id && scheduledDirectoryPathKey(a.path) === scheduledDirectoryPathKey(b.path) && a.enabled === b.enabled && a.interval === b.interval

export function ScheduledImportSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const project = useWikiStore(s => s.project)
  const scheduledImportConfig = useWikiStore(s => s.scheduledImportConfig)
  const dataVersion = useWikiStore(s => s.dataVersion)
  const [scanning, setScanning] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [registered, setRegistered] = useState<{ projectPath: string; origins: ManualSourceOrigin[]; error?: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!project) return
    void loadExternalSources(project.path).then(
      registry => { if (!cancelled) setRegistered({ projectPath: project.path, origins: manualSourceOrigins(registry) }) },
      () => { if (!cancelled) setRegistered({ projectPath: project.path, origins: [], error: "暂时无法读取来源登记，请检查知识库访问权限。" }) },
    )
    return () => { cancelled = true }
  }, [project?.path, dataVersion])
  const origins = registered && registered.projectPath === project?.path ? registered.origins : []
  const directories = scheduledImportDraftDirectories(draft, project?.path)
  const savedDirectories = normalizeScheduledImportConfig(scheduledImportConfig, project?.path).directories ?? []
  const update = (id: string, patch: Partial<ScheduledImportDirectory>) => setDraft("scheduledImportDirectories", directories.map(row => row.id === id ? { ...row, ...patch } : row))
  async function addDirectories() {
    const selected = await open({ directory: true, multiple: true, defaultPath: scheduledImportBrowsePath(project?.path, "", origins), title: "添加额外监控目录" })
    if (!selected) return
    const paths = Array.isArray(selected) ? selected : [selected]
    const appended = appendScheduledImportDraftDirectories(directories, paths)
    if (appended.addedCount) setDraft("scheduledImportDirectories", appended.directories)
    setNotice(appended.duplicates ? `已跳过 ${appended.duplicates} 个重复目录。新增设置需点击页面底部“保存”后生效。` : "目录已加入草稿，点击页面底部“保存”后开始按周期监控。")
  }
  async function chooseDirectory(row: ScheduledImportDirectory) {
    const selected = await open({ directory: true, defaultPath: scheduledImportBrowsePath(project?.path, row.path, origins), title: "选择额外监控目录" })
    if (selected && typeof selected === "string") update(row.id, { path: selected, lastScan: null })
  }
  async function scanSavedDirectory(row: ScheduledImportDirectory) {
    if (!project || scanning) return
    setScanning(row.id); setNotice(null)
    try {
      await scanRegisteredExternalSources(project)
      await scanAndImport(project, row.path)
      setNotice("扫描请求已执行。请查看该目录的上次扫描时间及入库队列；扫描完成不代表模型入库已完成。")
    } catch (error) { setNotice(`扫描失败：${String(error)}`) }
    finally { setScanning(null) }
  }
  async function checkManualSources() {
    if (!project || scanning) return
    setScanning("manual"); setNotice(null)
    try {
      await scanRegisteredExternalSources(project)
      const registry = await loadExternalSources(project.path)
      setRegistered({ projectPath: project.path, origins: manualSourceOrigins(registry) })
      setNotice("已检查手动登记来源。变更任务请在入库队列查看；暂时不可访问的来源会保留。")
    } catch (error) { setNotice(`检查失败：${String(error)}`) }
    finally { setScanning(null) }
  }
  return <div className="space-y-6">
    <div><h2 className="text-xl font-semibold">{t("settings.sections.scheduledImport.title", { defaultValue: "来源与自动同步" })}</h2><p className="mt-1 text-sm leading-relaxed text-muted-foreground">手动登记的原文位置始终自动监控；也可为当前知识库添加多个额外监控目录。</p></div>
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100"><div className="mb-1 flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4"/>手动来源：自动监控始终开启</div>应用运行并打开当前项目时，约每分钟检查通过“＋文件夹／＋导入”登记的真实原文位置。无需额外勾选开关；下方额外目录的启停和周期不会关闭这类监控。</div>
    <section className="space-y-3" aria-label="手动登记来源">
      <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">手动登记的原文位置</h3><Button size="sm" variant="outline" disabled={!project || Boolean(scanning)} onClick={() => void checkManualSources()}><RefreshCw className={`mr-1 h-3.5 w-3.5 ${scanning === "manual" ? "animate-spin" : ""}`}/>{scanning === "manual" ? "正在检查…" : "立即检查"}</Button></div>
      <ManualSourceOriginList origins={origins} error={registered?.projectPath === project?.path ? registered?.error : undefined}/>
    </section>
    <section className="space-y-3 border-t pt-5" aria-label="额外监控目录">
      <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">额外监控目录</h3><Button size="sm" onClick={() => void addDirectories()} disabled={!project}><Plus className="mr-1 h-4 w-4"/>添加监控目录</Button></div>
      <p className="text-xs leading-relaxed text-muted-foreground">可添加多个本地或共享目录，分别启停和设置周期。修改后点击页面底部“保存”生效。暂停或移除一条额外监控，会停止该目录后续自动检查，保留已入库资料与原文件。</p>
      {!directories.length && <div className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">尚未添加额外监控目录。上方手动来源仍会自动监控。</div>}
      <ExtraMonitorDirectoryList directories={directories} savedDirectories={savedDirectories} projectPath={project?.path} scanning={scanning} onChange={update} onBrowse={row => void chooseDirectory(row)} onScan={row => void scanSavedDirectory(row)} onRemove={id => { setDraft("scheduledImportDirectories", directories.filter(row => row.id !== id)); setNotice("已从草稿移除；保存后取消这条额外监控，原文件与已入库资料保留。") }}/>
    </section>
    <p className="rounded-lg border bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">直接读取原文件，不复制完整原文；本地保存 Wiki、来源索引和必要缓存。只处理变动，未变化文件会跳过。共享盘断连或权限异常会保留来源；确认删除后才撤回相关知识。raw/sources 是逻辑引用位置，不是必须手动选择的原文目录。</p>
    {notice && <p role="status" className="rounded-lg border bg-primary/5 p-3 text-xs leading-relaxed">{notice}</p>}
  </div>
}

interface ExtraListProps {
  directories: ScheduledImportDirectory[]; savedDirectories: ScheduledImportDirectory[]; projectPath?: string; scanning?: string | null
  onChange: (id: string, patch: Partial<ScheduledImportDirectory>) => void; onBrowse: (row: ScheduledImportDirectory) => void; onScan: (row: ScheduledImportDirectory) => void; onRemove: (id: string) => void
}
export function ExtraMonitorDirectoryList({ directories, savedDirectories, projectPath, scanning, onChange, onBrowse, onScan, onRemove }: ExtraListProps) {
  return <div className="space-y-3">{directories.map((row, index) => {
    const saved = savedDirectories.find(item => item.id === row.id)
    const dirty = !saved || !sameDirectorySettings(row, saved)
    const errors = validateScheduledImportDirectories([row], projectPath).map(message => message.replace(/^监控目录 1/, `额外目录 ${index + 1}`))
    const lastScan = saved && scheduledDirectoryPathKey(saved.path) === scheduledDirectoryPathKey(row.path) ? saved.lastScan : null
    return <article key={row.id} className="space-y-3 rounded-lg border bg-card p-4" aria-label={`额外目录 ${index + 1}`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2 font-medium text-sm"><Folder className="h-4 w-4 text-muted-foreground"/>额外目录 {index + 1}<span className={`rounded-full px-2 py-0.5 text-[10px] ${dirty ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100" : row.enabled ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100" : "bg-muted text-muted-foreground"}`}>{dirty ? "待保存" : row.enabled ? "自动监控已启用" : "自动监控已暂停"}</span></div><Button size="sm" variant="ghost" onClick={() => onRemove(row.id)} aria-label={`移除额外目录 ${index + 1}`} title="只取消此条监控，保留资料"><Trash2 className="mr-1 h-3.5 w-3.5"/>移除</Button></div>
      <Label htmlFor={`monitor-path-${row.id}`} className="text-xs">原始目录（本机路径或 UNC 共享路径）</Label><div className="flex gap-2"><Input id={`monitor-path-${row.id}`} value={row.path} onChange={event => onChange(row.id, { path: event.target.value, lastScan: null })} placeholder="请选择外部原始目录" className="min-w-0 flex-1"/><Button size="icon" variant="outline" onClick={() => onBrowse(row)} aria-label={`选择额外目录 ${index + 1}`}><Folder className="h-4 w-4"/></Button></div>
      {errors.length > 0 && <p role="alert" className={`text-xs leading-relaxed ${row.enabled ? "text-destructive" : "text-amber-700 dark:text-amber-300"}`}>{errors.join("；")}{!row.enabled && "。此条已暂停，启用前请修正。"}</p>}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-xs"><label className="flex items-center gap-2"><input type="checkbox" checked={row.enabled} onChange={event => onChange(row.id, { enabled: event.target.checked })}/>启用此目录自动监控</label><div className="flex items-center gap-2"><Label htmlFor={`monitor-interval-${row.id}`} className="text-xs">检查周期</Label><Input id={`monitor-interval-${row.id}`} type="number" min={1} max={1440} value={row.interval} onChange={event => { const value=parseInt(event.target.value,10); onChange(row.id,{interval:Number.isFinite(value)?Math.max(1,Math.min(1440,value)):1}) }} className="w-20"/><span>分钟</span></div></div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs"><span className="flex items-center gap-1 text-muted-foreground"><Clock className="h-3.5 w-3.5"/>上次扫描：{lastScan ? new Date(lastScan).toLocaleString() : "尚未扫描"}</span><Button size="sm" variant="outline" disabled={Boolean(scanning) || dirty || errors.length > 0 || !projectPath} onClick={() => onScan(row)} title={dirty ? "请先保存此目录设置" : "立即检查一次，不改变自动监控开关"}>{scanning === row.id ? <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin"/> : <Play className="mr-1 h-3.5 w-3.5"/>}{dirty ? "保存后可扫描" : scanning === row.id ? "扫描中…" : "立即扫描"}</Button></div>
    </article>
  })}</div>
}

export function ManualSourceOriginList({ origins, error }: { origins: ManualSourceOrigin[]; error?: string }) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? origins : origins.slice(0, 10)
  return <div className="rounded-lg border bg-muted/20 p-3 text-xs">
    <div className="font-medium">已登记 {origins.length} 处原始位置 · 始终自动监控</div>
    <p className="mt-2 leading-relaxed text-muted-foreground">这里展示真实原文位置，不需要重复添加为额外目录。文件夹会检查子目录和新增文件；单独导入的文件只检查已登记文件。raw/sources 是逻辑引用，不代表原文件已复制。</p>
    {error ? <p className="mt-2 text-destructive">{error}</p> : origins.length === 0 ? <p className="mt-2 text-muted-foreground">当前项目暂无手动登记的外部来源。可在“原始资料”通过“＋文件夹／＋导入”添加。</p> : <div className="mt-3 space-y-2">{visible.map(origin => <div key={`${origin.kind}:${origin.path}`} className="rounded border bg-background p-2"><div className="mb-1 text-muted-foreground">{origin.kind === "folder" ? "文件夹" : "文件"} · 已登记 {origin.count} 个文件</div><code className="block break-all">{origin.path}</code></div>)}{origins.length > 10 && <button type="button" className="underline" onClick={() => setShowAll(value => !value)}>{showAll ? "收起" : `查看全部 ${origins.length} 处`}</button>}</div>}
  </div>
}

import { useEffect, useState } from "react"
import { FolderOpen, Plus, Clock, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getRecentProjects, removeFromRecentProjects } from "@/lib/project-store"
import type { WikiProject } from "@/types/wiki"
import { useTranslation } from "react-i18next"
import logo from "@/assets/foxess/foxess-official-logo.webp"
import { UserGuide } from "@/components/brand/user-guide"

interface WelcomeScreenProps {
  onCreateProject: () => void
  onOpenProject: () => void
  onSelectProject: (project: WikiProject) => void
}

export function WelcomeScreen({
  onCreateProject,
  onOpenProject,
  onSelectProject,
}: WelcomeScreenProps) {
  const { t } = useTranslation()
  const [recentProjects, setRecentProjects] = useState<WikiProject[]>([])
  const [help,setHelp]=useState(false)

  useEffect(() => {
    let active = true
    const refresh = () => { void getRecentProjects().then(projects => { if (active) setRecentProjects(projects) }).catch(() => {}) }
    const onVisible = () => { if (document.visibilityState === "visible") refresh() }
    refresh()
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", onVisible)
    return () => { active = false; window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", onVisible) }
  }, [])

  async function handleRemoveRecent(e: React.MouseEvent, path: string) {
    e.stopPropagation()
    await removeFromRecentProjects(path)
    const updated = await getRecentProjects()
    setRecentProjects(updated)
  }

  return (
    <div className="fox-welcome flex h-full items-center justify-center overflow-auto bg-background p-6">
      <div className="grid w-full max-w-[1080px] overflow-hidden rounded-[28px] border bg-card shadow-xl shadow-primary/5 lg:grid-cols-[0.95fr_1.05fr]">
      <aside className="fox-welcome-story flex flex-col justify-between gap-14 p-10 text-white"><div><div className="flex items-center gap-3"><img src={logo} alt="Fox ESS" className="h-12 w-12"/><div><div className="text-xl font-bold">FoxEss WIKI</div><div className="mt-1 text-[10px] tracking-[0.2em] text-white/60">KNOWLEDGE WORKSPACE</div></div></div><div className="mt-12 text-[11px] font-medium tracking-[0.2em] text-lime-200">资料 · 关联 · 证据</div><h1 className="mt-4 text-4xl font-semibold leading-[1.35] tracking-tight">让每一份资料，<br/>成为可追溯的知识。</h1><p className="mt-5 max-w-sm text-sm leading-7 text-white/70">汇聚产品手册、设备参数与标准规范，在知识之间建立联系，让每次提问都有据可查。</p></div><div className="grid grid-cols-3 gap-3 text-xs"><div className="border-t border-white/20 pt-3"><span className="text-lime-200">01</span><div className="mt-2">汇聚资料</div></div><div className="border-t border-white/20 pt-3"><span className="text-lime-200">02</span><div className="mt-2">编译知识</div></div><div className="border-t border-white/20 pt-3"><span className="text-lime-200">03</span><div className="mt-2">追溯答案</div></div></div></aside>
      <div className="flex min-w-0 flex-col items-center justify-center gap-7 p-8 lg:p-10">
        <div className="text-center">
          <h2 className="text-2xl font-bold">打开你的知识工作台</h2>
          <p className="mt-2 text-muted-foreground">
            创建新知识库，或继续使用已有资料与知识。
          </p>
        </div>

        <div className="flex gap-3">
          <Button onClick={onCreateProject}>
            <Plus className="mr-2 h-4 w-4" />
            新建知识库
          </Button>
          <Button variant="outline" onClick={onOpenProject}>
            <FolderOpen className="mr-2 h-4 w-4" />
            打开已有知识库
          </Button>
        </div>

        {recentProjects.length > 0 && (
          <div className="w-full max-w-md">
            <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              {t("welcome.recentProjects")}
            </div>
            <div className="rounded-lg border">
              {recentProjects.map((proj) => (
                <button
                  key={proj.path}
                  onClick={() => onSelectProject(proj)}
                  className="group flex w-full items-center justify-between border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-accent"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{proj.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {proj.path}
                    </div>
                  </div>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={(e) => handleRemoveRecent(e, proj.path)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRemoveRecent(e as unknown as React.MouseEvent, proj.path)
                    }}
                    className="ml-2 shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-destructive/10 group-hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="w-full rounded-xl border bg-primary/5 p-4 text-xs leading-6 text-muted-foreground"><span className="font-semibold text-primary">企业默认模型已内置</span><br/>连接企业网络后可直接使用，也可在模型设置中添加其他服务。<button onClick={()=>setHelp(true)} className="mt-2 block font-medium text-primary underline underline-offset-4">查看使用手册 →</button></div>
      </div></div><UserGuide open={help} onOpenChange={setHelp}/>
    </div>
  )
}

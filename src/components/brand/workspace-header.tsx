import { useState } from "react"
import { BookOpen, ShieldCheck, ArrowLeftRight } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"
import { UserGuide } from "./user-guide"
const views: Record<string,string>={chat:"知识对话",wiki:"知识页面",sources:"原始资料",search:"全库检索",graph:"知识关系图",lint:"知识检查",review:"待审阅",settings:"应用设置",skills:"智能能力",research:"深度研究"}
export function WorkspaceHeader({onSwitchProject}:{onSwitchProject:()=>void}){
  const project=useWikiStore(s=>s.project),view=useWikiStore(s=>s.activeView)
  const [help,setHelp]=useState(false)
  useWikiStore(s=>s.llmConfig)
  useWikiStore(s=>s.providerConfigs)
  useWikiStore(s=>s.taskModelRouting)
  const model=getTaskLlmConfig(view==="sources"?"ingest":"chat")
  return <><header className="fox-workspace-header flex h-14 shrink-0 items-center justify-between gap-4 border-b px-5">
    <div className="min-w-0"><div className="truncate text-sm font-semibold" title={project?.path}>{project?.name??"知识库工作台"}</div><div className="mt-0.5 text-xs text-muted-foreground">{views[view]??"知识工作区"}</div></div>
    <div className="flex shrink-0 items-center gap-2"><span className="hidden items-center gap-1.5 rounded-full border bg-background/70 px-3 py-1.5 text-[11px] text-muted-foreground xl:flex" title={model.model}><ShieldCheck className="h-3.5 w-3.5 text-emerald-600"/>{model.model||"请选择模型"}</span><button onClick={onSwitchProject} className="fox-header-button" title="切换或打开其他知识库"><ArrowLeftRight className="h-3.5 w-3.5"/><span className="hidden sm:inline">切换知识库</span></button><button onClick={()=>setHelp(true)} className="fox-header-button"><BookOpen className="h-3.5 w-3.5"/>使用手册</button></div>
  </header>{project&&<div className="sr-only">{project.path}</div>}<UserGuide open={help} onOpenChange={setHelp}/></>
}

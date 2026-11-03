import { useRef } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Dialog,DialogContent,DialogHeader,DialogTitle } from "@/components/ui/dialog"
import manual from "@/content/user-manual.zh.md?raw"
import { openUrl } from "@tauri-apps/plugin-opener"
export function UserGuide({open,onOpenChange}:{open:boolean;onOpenChange:(v:boolean)=>void}){
  const headingRef=useRef<HTMLHeadingElement>(null)
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent initialFocus={headingRef} className="flex h-[86vh] w-[min(1100px,94vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"><DialogHeader className="border-b bg-primary/5 px-7 py-5"><DialogTitle ref={headingRef} tabIndex={-1} className="outline-none">FoxEss WIKI · 使用手册</DialogTitle><p className="text-xs text-muted-foreground">从资料入库、模型切换，到有依据的知识问答。</p></DialogHeader><div className="min-h-0 flex-1 overflow-y-auto px-7 py-6"><article className="fox-manual mx-auto max-w-4xl"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{a:({href,children})=><a href={href} onClick={event=>{event.preventDefault();if(href?.startsWith("https://"))void openUrl(href)}}>{children}</a>}}>{manual}</ReactMarkdown></article></div></DialogContent></Dialog>
}

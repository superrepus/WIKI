import { getFileName, normalizePath } from "@/lib/path-utils"
export function externalRootId(path: string): string {
  let hash=2166136261
  for (const c of normalizePath(path).replace(/\/+$/, "").toLowerCase()) {hash^=c.charCodeAt(0);hash=Math.imul(hash,16777619)}
  return (hash>>>0).toString(36)
}
/** A stable project identity; no source bytes are materialized at this path. */
export function externalSourceLogicalPath(projectPath:string, sourcePath:string, rootPath?:string): string {
  const pp=normalizePath(projectPath).replace(/\/+$/, ""), sp=normalizePath(sourcePath)
  const root=normalizePath(rootPath??sp.slice(0,sp.lastIndexOf("/"))).replace(/\/+$/, "")
  const relative=sp.toLowerCase().startsWith(root.toLowerCase()+"/")?sp.slice(root.length+1):getFileName(sp)
  if(relative.split("/").some(p=>!p||p==="."||p===".."))throw new Error("Invalid external source relative path")
  return `${pp}/raw/sources/external/${externalRootId(root)}/${relative}`
}

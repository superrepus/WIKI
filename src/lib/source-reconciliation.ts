/** Accurate retraction for explicitly managed projects, layered on upstream ingest.
 * The upstream analysis, entity generation, merge, lint and retrieval stay intact.
 */
import { createDirectory, deleteFile, fileExists, getFileMd5, listDirectory, readFile, writeFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { parseFrontmatterArray, parseSources } from "@/lib/sources-merge"
import { sourceIdentityForPath, sourceReferenceIdentity } from "@/lib/source-identity"
import { normalizeWikiRefKey } from "@/lib/wiki-cleanup"
import { removeFromIngestCache } from "@/lib/ingest-cache"
import { removeParsedMarkdown } from "@/lib/parsed-source-output"
import type { FileNode } from "@/types/wiki"
import { refreshWikiCatalog } from "./wiki-catalog"
import { withProjectLock } from "./project-mutex"
import { loadReviewItems, saveReviewItems } from "./persist"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import { readSourceProvenance } from "@/commands/fs"

export interface SourceReconciliationState {
  version: 1
  enabled: boolean
  generation: number
  blocked: boolean
  sources: Record<string, string>
  pages: Record<string, string[]>
  pendingSources: string[]
  retraction?: { sources: string[]; deleteSources: boolean }
}

export interface SourceRevision {
  generation: number
  hash: string
}

const aggregate = new Set(["wiki/index.md", "wiki/overview.md", "wiki/log.md"])
const statePath = (pp: string) => `${normalizePath(pp)}/.llm-wiki/source-reconciliation.json`

export async function loadSourceReconciliation(pp: string): Promise<SourceReconciliationState | null> {
  // Existing projects are unchanged until the deployment explicitly opts in.
  if (!(await fileExists(statePath(pp)))) return null
  const state = JSON.parse(await readFile(statePath(pp))) as SourceReconciliationState
  if (!state.enabled) return null
  if (state.version !== 1 || !Number.isInteger(state.generation) || !state.pages || !state.sources) {
    throw new Error("Source reconciliation state is invalid; refusing unsafe writes")
  }
  return state
}

async function saveState(pp: string, state: SourceReconciliationState): Promise<void> {
  await writeFileAtomic(statePath(pp), JSON.stringify(state, null, 2))
}

export async function captureSourceRevision(pp: string, sp: string): Promise<SourceRevision | null> {
  const state = await loadSourceReconciliation(pp)
  if (!state) return null
  if (state.blocked) throw new Error("Source retraction is in progress; retry after reconciliation")
  const hash = await getFileMd5(sp)
  // Register before any page write, including partial generations that fail.
  state.sources[sourceReferenceIdentity(sourceIdentityForPath(pp, sp))] = hash
  await saveState(pp, state)
  return { generation: state.generation, hash }
}

export async function assertSourceRevision(pp: string, sp: string, revision: SourceRevision | null): Promise<void> {
  if (!revision) return
  const state = await loadSourceReconciliation(pp)
  if (!state || state.blocked || state.generation !== revision.generation || await getFileMd5(sp) !== revision.hash) {
    throw new Error("Source changed or was retracted during generation; stale output discarded")
  }
}

export async function recordSourceDependencies(pp: string, sp: string, revision: SourceRevision | null, paths: readonly string[]): Promise<void> {
  if (!revision) return
  // The original compiler calls this inside its runCommit project lock. This
  // mutex is not reentrant; acquiring it again would stall every managed ingest.
  await assertSourceRevision(pp, sp, revision)
  await recordSourceDependenciesImpl(pp, sp, revision, paths)
}

async function recordSourceDependenciesImpl(pp: string, sp: string, revision: SourceRevision, paths: readonly string[]): Promise<void> {
  const state = await loadSourceReconciliation(pp)
  if (!state) throw new Error("Source reconciliation state disappeared")
  const identity = sourceReferenceIdentity(sourceIdentityForPath(pp, sp))
  state.sources[identity] = revision.hash
  state.pendingSources = state.pendingSources.filter(s => s !== identity)
  // Generation sees the project index/overview and merge sees existing pages.
  // Until read-level provenance exists, conservatively record all sources that
  // could influence these contexts. This favors recall over minimal rebuilds.
  const influences = Object.keys(state.sources)
  for (const path of paths) {
    const rel = normalizePath(path).replace(`${normalizePath(pp)}/`, "")
    if (aggregate.has(rel) || !rel.startsWith("wiki/") || !rel.endsWith(".md")) continue
    state.pages[rel] = [...new Set([...(state.pages[rel] ?? []), ...influences, identity])]
  }
  // Directory pages are structural navigation, not invented semantic claims.
  // Entity/concept/comparison/synthesis content still comes from autoIngest.
  const allPages = flatten(await listDirectory(`${normalizePath(pp)}/wiki`))
  const summaries: Array<{ path: string; sources: string[] }> = []
  for (const page of allPages) {
    const rel = page.path.slice(normalizePath(pp).length + 1)
    if (rel.startsWith("wiki/topics/")) continue
    summaries.push({ path: rel, sources: parseSources(await readFile(page.path)) })
  }
  const directories = new Map<string, string[]>()
  for (const source of Object.keys(state.sources)) {
    const parts = source.split("/").slice(0, -1)
    for (let n = 0; n <= parts.length; n++) {
      const dir = parts.slice(0, n).join("/")
      directories.set(dir, [...(directories.get(dir) ?? []), source])
    }
  }
  const topicLinks: string[] = []
  for (const [directory, deps] of directories) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(directory))
    const slug = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
    const rel = `wiki/topics/directory-${slug}.md`
    const related = summaries.filter(page => page.sources.some(source => sourceMatches(source, deps)))
    const links = related.map(page => `- [[${page.path.replace(/^wiki\//, "").replace(/\.md$/, "")}]]`).join("\n")
    await createDirectory(`${normalizePath(pp)}/wiki/topics`)
    await writeFile(`${normalizePath(pp)}/${rel}`, `---\ntype: topic\ntitle: ${JSON.stringify(directory || "全部来源")}\nsources: ${JSON.stringify(deps)}\n---\n\n# ${directory || "全部来源"}\n\n此页按来源目录自动组织导航。参数与分析请阅读链接的原版编译页面。\n\n${links}\n`)
    state.pages[rel] = deps
    topicLinks.push(`- [[${rel.replace(/^wiki\//, "").replace(/\.md$/, "")}]]`)
  }
  const index = `${normalizePath(pp)}/wiki/index.md`
  const content = (await readFile(index)).replace(/\n<!-- directory-topics -->[\s\S]*?<!-- \/directory-topics -->/g, "")
  await writeFile(index, `${content}\n<!-- directory-topics -->\n## 来源目录\n${topicLinks.join("\n")}\n<!-- /directory-topics -->\n`)
  await saveState(pp, state)
}

export interface RetractionPage { path: string; content: string }

function sourceMatches(source: string, removed: readonly string[]): boolean {
  const key = sourceReferenceIdentity(normalizePath(source)).toLowerCase()
  return removed.some(r => {
    const canonical = sourceReferenceIdentity(normalizePath(r)).toLowerCase()
    return key === canonical || (!key.includes("/") && key === canonical.split("/").pop())
  })
}

export function planSourceRetraction(pages: readonly RetractionPage[], removed: readonly string[], provenance: Record<string, string[]> = {}) {
  const affected = new Set<string>()
  const links = (content: string) => [...content.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)].map(m => m[1])
  for (const page of pages) {
    if (aggregate.has(page.path)) continue
    const deps = [...parseSources(page.content), ...(provenance[page.path] ?? [])]
    if (deps.some(s => sourceMatches(s, removed))) affected.add(page.path)
  }
  // Follow actual page dependencies to downstream synthesis/comparison pages.
  let changed = true
  while (changed) {
    changed = false
    const canonical = (p: string) => p.replace(/\\/g, "/").replace(/^wiki\//i, "").replace(/\.md$/i, "").toLowerCase()
    const keys = new Set([...affected].map(canonical))
    const bareKeys = new Set([...affected].map(normalizeWikiRefKey))
    for (const page of pages) {
      if (affected.has(page.path) || aggregate.has(page.path)) continue
      const refs = [...links(page.content), ...parseFrontmatterArray(page.content, "related")]
      if (refs.some(ref => ref.replace(/^wiki\//i, "").includes("/") ? keys.has(canonical(ref)) : bareKeys.has(normalizeWikiRefKey(ref)))) {
        affected.add(page.path); changed = true
      }
    }
  }
  const survivors = new Set<string>()
  for (const page of pages) {
    if (!affected.has(page.path)) continue
    for (const source of [...parseSources(page.content), ...(provenance[page.path] ?? [])]) {
      if (!sourceMatches(source, removed)) survivors.add(sourceReferenceIdentity(source))
    }
  }
  return { affected: [...affected], survivors: [...survivors] }
}

function flatten(nodes: readonly FileNode[]): FileNode[] {
  return nodes.flatMap(n => n.is_dir ? flatten(n.children ?? []) : n.name.endsWith(".md") ? [n] : [])
}

export async function retractManagedSourceKnowledge(pp: string, sources: readonly string[], deleteSources: boolean) {
  const state = await loadSourceReconciliation(pp)
  if (!state) return null
  const root = normalizePath(pp)
  const absolute = sources.map(s => normalizePath(s).startsWith(`${root}/`) ? normalizePath(s) : `${root}/${normalizePath(s)}`)
  if (absolute.some(s => !s.startsWith(`${root}/raw/sources/`) || s.split("/").includes(".."))) {
    throw new Error("Managed source retraction is limited to project raw/sources")
  }
  const identities = absolute.map(s => sourceReferenceIdentity(sourceIdentityForPath(root, s)))
  // Block native API/read paths before touching any derived content. Persisted
  // blocked state deliberately survives a crash until recovery retries it.
  state.generation++
  state.blocked = true
  state.retraction = { sources: [...sources], deleteSources }
  await saveState(root, state)
  const nodes = flatten(await listDirectory(`${root}/wiki`))
  const pages = await Promise.all(nodes.map(async n => ({ path: n.path.slice(root.length + 1), content: await readFile(n.path) })))
  const provenance = { ...state.pages }
  const journal = `${root}/.llm-wiki/source-page-dependencies.jsonl`
  if (await fileExists(journal)) {
    const recorded = await readSourceProvenance(root)
    for (const [path, sources] of Object.entries(recorded)) provenance[path] = [...new Set([...(provenance[path] ?? []), ...sources])]
  }
  // A page with no reliable dependency record may contain facts copied by an
  // Agent or imported from an older build. Invalidate it rather than guess.
  for (const page of pages) if (!provenance[page.path]?.length) provenance[page.path] = [...identities, ...parseSources(page.content)]
  const plan = planSourceRetraction(pages, identities, provenance)
  const archive = `${root}/.llm-wiki/retracted/${Date.now()}-${state.generation}`
  const reviewBefore = await loadReviewItems(root)
  await createDirectory(`${archive}/.llm-wiki`)
  await writeFile(`${archive}/.llm-wiki/review.json`, JSON.stringify(reviewBefore))
  for (const page of pages) {
    if (!plan.affected.includes(page.path) && !aggregate.has(page.path)) continue
    const target = `${archive}/${page.path}`
    await createDirectory(target.slice(0, target.lastIndexOf("/")))
    await writeFile(target, page.content)
  }
  // Use upstream cascade: removes embeddings, media and dangling index/links.
  if (plan.affected.length) {
    const { cascadeDeleteWikiPagesWithRefs } = await import("@/lib/wiki-page-delete")
    await cascadeDeleteWikiPagesWithRefs(root, plan.affected.map(p => `${root}/${p}`))
    for (const path of plan.affected) {
      if (await fileExists(`${root}/${path}`)) throw new Error(`Retraction incomplete: ${path}; project remains blocked`)
    }
  }
  // Aggregates can contain factual prose, not only links. Replace them with
  // navigation built solely from surviving pages; keep old content in archive.
  const valid = pages.filter(p => !plan.affected.includes(p.path) && !aggregate.has(p.path))
  const navigation = valid.map(p => `- [[${p.path.replace(/^wiki\//, "").replace(/\.md$/, "")}]]`).join("\n")
  await writeFile(`${root}/wiki/index.md`, `# Wiki Index\n\n${navigation}\n`)
  await writeFile(`${root}/wiki/overview.md`, `# Wiki Overview\n\n来源已变更，受影响知识已撤回，等待原版编译器重建。\n\n${navigation}\n`)
  await writeFile(`${root}/wiki/log.md`, `# Wiki Log\n\n${new Date().toISOString()} 来源撤回；归档位于 .llm-wiki/retracted。\n`)
  if (deleteSources) for (const sp of absolute) if (await fileExists(sp)) await deleteFile(sp)
  for (const sp of absolute) {
    await removeParsedMarkdown(root, sp)
    const name = sp.split("/").pop() ?? ""
    for (const suffix of [".txt", ".txt.parser"]) {
      const cache = `${sp.slice(0, sp.lastIndexOf("/"))}/.cache/${name}${suffix}`
      if (await fileExists(cache)) await deleteFile(cache)
    }
  }
  for (const identity of identities) {
    delete state.sources[identity]
    await removeFromIngestCache(root, identity)
  }
  for (const p of plan.affected) delete state.pages[p]
  // A review can quote deleted facts even when it has no affectedPages field.
  const retiredSources = [...identities, ...plan.survivors]
  const affectedKeys = new Set(plan.affected.map(normalizeWikiRefKey))
  // Retire mixed review descriptions too; upstream pruning only removes their
  // links and cannot prove that the remaining prose is independent of A.
  const kept = reviewBefore.filter(item => {
    if (!item.sourcePath && !item.affectedPages?.length) return false
    if (item.sourcePath && sourceMatches(sourceIdentityForPath(root, item.sourcePath), retiredSources)) return false
    return !item.affectedPages?.some(p => affectedKeys.has(normalizeWikiRefKey(p)))
  })
  await saveReviewItems(root, kept)
  const active = useWikiStore.getState().project
  if (active && normalizePath(active.path) === root) useReviewStore.getState().setItems(kept)
  state.pendingSources = [...new Set([...state.pendingSources, ...plan.survivors])].filter(s => !sourceMatches(s, identities))
  state.blocked = false
  // Publish no stale catalog rows or excerpts after withdrawal. Remain blocked
  // if the replacement catalog cannot be written.
  await refreshWikiCatalog(root)
  delete state.retraction
  await saveState(root, state)
  return { deletedWikiPaths: plan.affected.map(p => `${root}/${p}`), rewrittenSourcePages: 0, skippedPages: 0 }
}

export async function pendingReconciliationSources(pp: string): Promise<string[]> {
  const state = await loadSourceReconciliation(pp)
  if (!state || state.blocked) return []
  const result: string[] = []
  for (const identity of state.pendingSources) {
    const absolute = `${normalizePath(pp)}/raw/sources/${sourceReferenceIdentity(identity)}`
    if (await fileExists(absolute)) result.push(absolute)
  }
  return result
}

export async function recoverPendingRetraction(pp: string): Promise<void> {
  const state = await loadSourceReconciliation(pp)
  if (!state?.blocked) return
  if (!state.retraction) throw new Error("Incomplete legacy retraction needs review; knowledge remains blocked")
  await withProjectLock(pp, () => retractManagedSourceKnowledge(pp, state.retraction!.sources, state.retraction!.deleteSources))
}

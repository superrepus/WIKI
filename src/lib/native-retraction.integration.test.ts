/** Integration: actual original Rust API plus original source cascade. */
import { expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { realFs } from '@/test-helpers/fs-temp'
vi.mock('@/commands/fs', () => ({ ...realFs, writeFileAtomic: realFs.writeFile,
  getFileMd5: async (p: string) => createHash('md5').update(await fs.readFile(p)).digest('hex') }))
import { retractManagedSourceKnowledge } from './source-reconciliation'
import { useWikiStore } from '@/stores/wiki-store'

it.skipIf(process.env.NATIVE_API_ACCEPTANCE !== '1')('withdraws shared, downstream and aggregate facts from the actual native API', async () => {
  const project = JSON.parse(await fs.readFile('windows-native/runtime/retraction-project.json', 'utf8'))
  const secrets = JSON.parse(await fs.readFile('windows-server/secrets.local.json', 'utf8'))
  const base = (process.env.NATIVE_API_BASE_URL || 'http://127.0.0.2:19828') + '/api/v1/projects/' + project.id
  const headers = { Authorization: 'Bearer ' + secrets.api_token, 'Content-Type': 'application/json' }
  const search = async () => {
    const response = await fetch(base + '/search', { method: 'POST', headers, body: JSON.stringify({ query: 'REMOVED_KNOWLEDGE_79181', includeContent: true }) })
    expect(response.status).toBe(200)
    return response.json()
  }
  const before = await search()
  expect(JSON.stringify(before)).toContain('REMOVED_KNOWLEDGE_79181')
  const graphBefore = await fetch(base + '/graph', { headers }); expect(graphBefore.status).toBe(200)
  const marker = project.path + '/.llm-wiki/source-reconciliation.json'
  const state = JSON.parse(await fs.readFile(marker, 'utf8'))
  await fs.writeFile(marker, JSON.stringify({ ...state, blocked: true }))
  const blocked = await fetch(base + '/graph', { headers })
  expect(blocked.status).toBe(503)
  await fs.writeFile(marker, JSON.stringify(state))
  useWikiStore.setState({ project: null })
  const result = await retractManagedSourceKnowledge(project.path, ['raw/sources/a.md'], true)
  const after = await search()
  expect(JSON.stringify(after)).not.toContain('REMOVED_KNOWLEDGE_79181')
  const read = await fetch(base + '/files/content?path=wiki/entities/shared.md', { headers })
  expect(read.status).toBe(404)
  const keep = await fetch(base + '/files/content?path=wiki/entities/keep.md', { headers })
  expect(keep.status).toBe(200)
  const graphAfter = await fetch(base + '/graph', { headers }); const graph = await graphAfter.json()
  expect(JSON.stringify(graph.nodes)).not.toContain('shared.md')
  expect(JSON.stringify(graph.nodes)).not.toContain('downstream.md')
  const final = JSON.parse(await fs.readFile(marker, 'utf8'))
  expect(final.pendingSources).toContain('b.md')
  const report = { passed: true, nativeApi: true, beforeHits: before.results.length, afterHits: after.results.length,
    blockedStatus: blocked.status, removedPageStatus: read.status, survivingPageStatus: keep.status,
    generation: final.generation, pendingSources: final.pendingSources, deletedPages: result?.deletedWikiPaths }
  await fs.writeFile('windows-native/runtime/native-retraction-acceptance.json', JSON.stringify(report, null, 2))
}, 60000)

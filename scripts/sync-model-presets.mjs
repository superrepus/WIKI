// Public preset defaults only. Credentials always remain in app-state.
import fs from 'node:fs/promises'
import ts from 'typescript'
const path = new URL('../src/components/settings/llm-presets.ts', import.meta.url)
const publicModel = JSON.parse(await fs.readFile(new URL('../src-tauri/resources/foxess-default-model.json', import.meta.url),'utf8'))
const source=(await fs.readFile(path,'utf8')).replace(/import foxessDefault from [^\n]+/,`const foxessDefault = ${JSON.stringify(publicModel)}`)
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { LLM_PRESETS } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const dir = new URL('../src-tauri/resources/', import.meta.url)
await fs.mkdir(dir, { recursive: true })
await fs.writeFile(new URL('llm-presets.json', dir), JSON.stringify(LLM_PRESETS, null, 2) + '\n')

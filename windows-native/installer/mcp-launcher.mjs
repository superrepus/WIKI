// Only application authentication settings are read; knowledge always goes through the API.
import fs from 'node:fs'
import path from 'node:path'
if (!process.env.LLM_WIKI_API_TOKEN) {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'com.llmwiki.app', 'app-state.json'), 'utf8').replace(/^\uFEFF/, ''))
    if (settings.apiConfig?.token) process.env.LLM_WIKI_API_TOKEN = settings.apiConfig.token
  } catch { /* The original MCP client reports missing API authentication. */ }
}
process.env.LLM_WIKI_API_BASE_URL ||= 'http://127.0.0.1:19828'
await import('../mcp-server/dist/src/index.js')

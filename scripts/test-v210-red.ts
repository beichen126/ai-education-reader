import fs from 'node:fs'
import 'fake-indexeddb/auto'
import { closeDb, idbClearAll } from '../src/storage/idb.ts'
import { getPromptPreferences } from '../src/prompts/prompt-preferences.ts'
import { listPromptCatalog } from '../src/prompts/prompt-service.ts'
import { savePromptRecord } from '../src/prompts/prompt-store.ts'
import { BUILTIN_PROMPT_IDS } from '../src/prompts/prompt-registry.ts'
import type { ConversationModePrompt } from '../src/prompts/prompt-types.ts'

let pass = 0
let fail = 0
function expect(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('PASS  ' + message) }
  else { fail++; console.log('FAIL  ' + message) }
}

await idbClearAll()
const initial = await listPromptCatalog('conversation-mode')
expect(initial.length === 1 && initial[0]?.id === BUILTIN_PROMPT_IDS.conversationDefault, 'V210-RED initial catalog contains only the canonical 默认 mode')

const custom: ConversationModePrompt = {
  id: 'v210-red-custom-mode',
  kind: 'conversation-mode',
  name: '数学证明教练',
  description: '用证明步骤解释数学问题',
  source: 'custom',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
  systemPrompt: '先明确命题，再逐步给出证明。',
}
await savePromptRecord(custom)
const afterCustom = await listPromptCatalog('conversation-mode')
expect(afterCustom.some(item => item.id === BUILTIN_PROMPT_IDS.conversationDefault) && afterCustom.some(item => item.id === custom.id), 'V210-RED saved custom mode is visible beside 默认')

const promptManagerSource = fs.readFileSync('src/prompts/PromptManager.tsx', 'utf8')
expect(!promptManagerSource.includes("category === 'conversation-mode'} disabled") && !promptManagerSource.includes("category === 'all' || category === 'conversation-mode'"), 'V210-RED Prompt Manager allows creating conversation modes')

const branchBarSource = fs.readFileSync('src/branches/BranchBar.tsx', 'utf8')
expect(branchBarSource.includes('ConversationModeSelector') || branchBarSource.includes('listSelectableConversationModes'), 'V210-RED current route exposes a selectable conversation-mode control')

const readme = fs.readFileSync('README.md', 'utf8')
for (const heading of ['30 秒理解本产品', '与 Zotero 等 PDF 阅读器有什么不同', '与 ChatGPT/DeepSeek 等 AI 网页端有什么不同', '自定义会话模式', 'FAQ']) {
  expect(readme.includes(heading), 'V210-RED README contains product section: ' + heading)
}
expect(fs.existsSync('src/help/product-guide.md'), 'V210-RED application product guide source exists')
expect(fs.existsSync('src/documents/reader-progress-controller.ts'), 'V210-RED reader progress controller exists')
expect(fs.existsSync('src/documents/continuous-pdf-viewport.tsx'), 'V210-RED continuous PDF viewport exists')
const settingsSource = fs.readFileSync('src/engine/settings-store.ts', 'utf8')
expect(settingsSource.includes('PdfNavigationMode') && settingsSource.includes('continuous'), 'V210-RED settings define persistent paged/continuous navigation mode')

const prefs = await getPromptPreferences()
expect(prefs.defaultConversationModeId === BUILTIN_PROMPT_IDS.conversationDefault, 'V210-RED clean install default preference remains canonical 默认')

console.log(`SUMMARY ${pass}/${pass + fail} passed`)
await closeDb()
process.exit(fail === 0 ? 0 : 1)

// Stage 12 browser gate: inspect built-in machine protocols, create/enable an
// experimental override, round-trip it through V6 backup, then restore canonical.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'
import { openAppDb } from './e2e-idb.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (error) => errors.push('pageerror: ' + error.message))
page.on('dialog', (dialog) => { void dialog.accept() })

const now = Date.now()
await seedAndBoot(page, {
  convs: [{ id: 'protocol-conversation', title: 'Protocol Inspector 测试', createdAt: now, updatedAt: now, messages: [msg('protocol-u1', 'user', '测试')] }],
  settings: { apiKey: 'sk-test', model: 'deepseek-chat', lastConversationId: 'protocol-conversation' },
})

const openManager = async () => {
  const direct = page.locator('[data-testid="sidebar-entry-prompts"]')
  if (await direct.isVisible().catch(() => false)) { await direct.click(); return }
  await page.locator('[data-testid="rail-history"]').click()
  await page.locator('[data-testid="sidebar-entry-prompts"]').click()
}

await openAppDb(page, {
  store: 'prompts',
  operation: 'put',
  value: {
    id: 'invalid-custom-protocol', kind: 'protocol', name: '无效自定义协议', description: '用于验证不可激活的 legacy-shaped row', source: 'custom', enabled: true,
    createdAt: now, updatedAt: now, revision: 1, domain: 'ai-toc-structure', systemPrompt: 'invalid', overridePolicy: 'experimental',
  },
})
await openManager()
const manager = page.locator('[data-testid="prompt-manager"]')
await manager.waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="prompt-category-protocol"]').click()
assert(await page.locator('[data-testid="prompt-new"]').isDisabled() && await page.locator('[data-testid="protocol-new-hint"]').innerText() === '系统协议请从 canonical 复制', 'system protocol category blocks generic new and explains the canonical-copy path')
await page.locator('[data-testid="prompt-row"]').filter({ hasText: '无效自定义协议' }).click()
assert(await page.locator('[data-testid="protocol-activate"]').isDisabled() && (await page.locator('[data-testid="protocol-activation-reason"]').innerText()).includes('experimental'), 'invalid protocol row shows a visible activation reason and disables activation')
await page.locator('[data-testid="prompt-delete"]').click()
await page.getByText('提示词已删除，历史 snapshot 保持不变。', { exact: true }).waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="prompt-row"]').filter({ hasText: 'AI 目录 · 结构分析' }).click()
await page.locator('[data-testid="protocol-inspector"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="prompt-editor-content"]').inputValue().then((value) => value.includes('levels')), 'built-in AI TOC protocol shows the complete actual system prompt')
assert(await page.locator('[data-testid="protocol-inspector"]').innerText().then((value) => value.includes('ai-toc-structure') || value.includes('AI TOC')), 'protocol inspector shows domain and effect location')
assert(await page.locator('[data-testid="protocol-inspector"]').innerText().then((value) => value.includes('parseTocStructure')), 'protocol inspector shows the validator metadata')
assert(await page.locator('[data-testid="prompt-copy"]').count() === 1 && await page.locator('[data-testid="protocol-activate"]').count() === 0, 'read-only canonical protocol can be copied but not enabled directly')

await page.locator('[data-testid="prompt-copy"]').click()
await page.getByText('已复制为新的自定义提示词。', { exact: true }).waitFor({ state: 'visible', timeout: 10000 })
const overrideId = await page.locator('[data-testid="prompt-row"][data-active="true"]').getAttribute('data-id')
assert(!!overrideId, 'copy creates a selected experimental protocol row')
await page.locator('[data-testid="prompt-editor-name"]').fill('实验结构协议')
await page.locator('[data-testid="prompt-editor-content"]').fill('实验结构协议：只输出 levels。')
await page.locator('[data-testid="prompt-save"]').click()
await page.getByText('提示词已保存。', { exact: true }).waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="protocol-activate"]').click()
await page.getByText('实验协议已启用。新请求开始前会冻结当前版本。', { exact: true }).waitFor({ state: 'visible', timeout: 10000 })
const activeBeforeBackup = await openAppDb(page, { store: 'settings', operation: 'get', key: 'promptPreferences' })
assert(activeBeforeBackup?.value?.activeProtocolOverrideByDomain?.['ai-toc-structure'] === overrideId, 'enable writes exactly one active override mapping')

await page.locator('[data-testid="prompt-manager-close"]').click()
await page.getByRole('button', { name: /打开设置|设置/ }).first().click()
await page.locator('text=数据与导出').waitFor({ state: 'visible', timeout: 8000 })
const dlPromise = page.waitForEvent('download', { timeout: 15000 })
await page.locator('button:has-text("导出完整备份 JSON")').click()
const download = await dlPromise
const backupPath = await download.path()
assert(!!backupPath, 'enabled protocol override is exportable in the complete backup')

await page.locator('[data-testid="settings-clear-data"]').click()
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 20000 })
await page.getByRole('button', { name: /打开设置|设置/ }).first().click()
const importInput = page.locator('input[type="file"][accept*=".json"]')
await importInput.setInputFiles(backupPath)
await page.locator('text=导入完成').waitFor({ state: 'visible', timeout: 20000 })
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 20000 })
const restoredPreference = await openAppDb(page, { store: 'settings', operation: 'get', key: 'promptPreferences' })
const restoredPrompt = await openAppDb(page, { store: 'prompts', operation: 'get', key: overrideId })
assert(restoredPreference?.value?.activeProtocolOverrideByDomain?.['ai-toc-structure'] === overrideId, 'backup restore preserves the active protocol mapping')
assert(restoredPrompt?.source === 'experimental' && restoredPrompt?.baseProtocolId, 'backup restore preserves experimental protocol lineage')

await openManager()
await manager.waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="prompt-category-protocol"]').click()
await page.locator('[data-testid="prompt-row"]').filter({ hasText: '实验结构协议' }).click()
await page.locator('[data-testid="protocol-restore"]').click()
await page.getByText('已恢复内置协议；实验版本和历史快照仍保留。', { exact: true }).waitFor({ state: 'visible', timeout: 10000 })
const restoredCanonical = await openAppDb(page, { store: 'settings', operation: 'get', key: 'promptPreferences' })
const retainedSnapshotSource = await openAppDb(page, { store: 'prompts', operation: 'get', key: overrideId })
assert(!restoredCanonical?.value?.activeProtocolOverrideByDomain?.['ai-toc-structure'], 'restore canonical clears only the active mapping')
assert(retainedSnapshotSource?.source === 'experimental', 'restore canonical does not delete the experimental history source')

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter((line) => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)

// Stage 10: legacy Custom Artifact Actions migrate into the Prompt catalog.
// CRUD after migration must use Prompt Manager, not the legacy settings facade.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'

const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)
const browser = await launchBrowser()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('dialog', dialog => { void dialog.accept() })

const now = Date.now()
const legacyName = '旧版操作-' + now
const migratedName = '迁移后操作-' + now
await seedAndBoot(page, {
  convs: [{ id: 'custom-action-conversation', title: '自定义操作迁移测试', createdAt: now, updatedAt: now, messages: [msg('U1', 'user', '源'), msg('A1', 'assistant', '答案')] }],
  settings: {
    apiKey: 'sk-test', model: 'deepseek-chat', lastConversationId: 'custom-action-conversation',
    customArtifactActions: [{ id: 'legacy-action-' + now, name: legacyName, prompt: '请把内容改写成迁移测试。', createdAt: now, updatedAt: now }],
  },
})

// The shared fixture boots once before seeding. Remove only the boot-created empty
// marker and prompt rows, then reload so this test exercises the real legacy migration
// with the seeded custom action present before the migration runs.
await page.evaluate(() => new Promise((resolve, reject) => {
  const req = indexedDB.open('ai-education-reader')
  req.onerror = () => reject(req.error)
  req.onsuccess = () => {
    const db = req.result
    const stores = ['settings', 'prompts'].filter((name) => db.objectStoreNames.contains(name))
    const tx = db.transaction(stores, 'readwrite')
    if (db.objectStoreNames.contains('settings')) tx.objectStore('settings').delete('promptMigrationV1')
    if (db.objectStoreNames.contains('prompts')) tx.objectStore('prompts').clear()
    tx.oncomplete = () => { db.close(); resolve(true) }
    tx.onerror = () => reject(tx.error)
  }
}))
await page.reload({ waitUntil: 'networkidle' })
await page.locator('[data-testid="composer-materials-input"]').waitFor({ state: 'attached', timeout: 20000 })

const openFromSidebar = async () => {
  const direct = page.locator('[data-testid="sidebar-entry-prompts"]')
  if (await direct.isVisible().catch(() => false)) { await direct.click(); return }
  await page.locator('[data-testid="rail-history"]').click()
  await page.locator('[data-testid="sidebar-entry-prompts"]').click()
}

await openFromSidebar()
const manager = page.locator('[data-testid="prompt-manager"]')
await manager.waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="prompt-category-artifact"]').click()
await page.locator('[data-testid="prompt-search"]').fill(legacyName)
assert(await page.locator('[data-testid="prompt-row"]').count() === 0, 'legacy Custom Artifact Action is hidden from the new Artifact catalog')
const migratedRow = await page.evaluate((id) => new Promise((resolve) => {
  const request = indexedDB.open('ai-education-reader')
  request.onsuccess = () => {
    const db = request.result
    const get = db.transaction('prompts', 'readonly').objectStore('prompts').get(id)
    get.onsuccess = () => { const row = get.result; db.close(); resolve(row ? { content: row.userPrompt, kind: row.artifactKind } : null) }
    get.onerror = () => { db.close(); resolve(null) }
  }
  request.onerror = () => resolve(null)
}), 'legacy-action-' + now)
assert(migratedRow?.kind === 'custom' && migratedRow?.content.includes('迁移测试'), 'hidden migrated Artifact prompt remains durable with its original content')

await page.locator('[data-testid="prompt-manager-close"]').click()
await page.reload({ waitUntil: 'networkidle' })
await page.locator('[data-testid="composer-materials-input"]').waitFor({ state: 'attached', timeout: 20000 })
await openFromSidebar()
await manager.waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="prompt-category-artifact"]').click()
await page.locator('[data-testid="prompt-search"]').fill(migratedName)
assert(await page.locator('[data-testid="prompt-row"]').count() === 0, 'migrated Artifact prompt remains hidden after reload')
const durableAfterReload = await page.evaluate((id) => new Promise((resolve) => {
  const request = indexedDB.open('ai-education-reader')
  request.onsuccess = () => {
    const db = request.result
    const get = db.transaction('prompts', 'readonly').objectStore('prompts').get(id)
    get.onsuccess = () => { const row = get.result; db.close(); resolve(!!row) }
    get.onerror = () => { db.close(); resolve(false) }
  }
  request.onerror = () => resolve(false)
}), 'legacy-action-' + now)
assert(durableAfterReload, 'migrated Artifact prompt survives reload in durable storage')

await browser.close()
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length && errors.length === 0 ? 0 : 1)

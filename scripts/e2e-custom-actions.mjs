// v1.2.0 P1: builtin preset 另存为自定义操作 in the create dialog + persistence.
// Opens the create dialog in custom mode, selects the builtin 总结 preset, ediits name+prompt,
// clicks 保存为操作, asserts a NEW saved action appears, and survives a reload.
import { chromium } from 'playwright-core'
import { msg, seedAndBoot } from './e2e-fixture.mjs'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('[data-testid="composer-materials-input"]').waitFor({ state: 'attached', timeout: 25000 })
const conv = { id: 'art', title: '成果对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [ msg('U1','user','源'), msg('A1','assistant','答案') ] }
await seedAndBoot(page, { convs: [conv], settings: { apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com', lastConversationId: 'art' } })

const openCustom = async () => {
  await page.locator('button[aria-label="消息操作"]').first().click()
  await page.locator('text=整理成笔记').click()
  await page.locator('text=创建学习成果').waitFor({ state: 'visible', timeout: 5000 })
  await page.locator('button:has-text("自定义处理")').click()
  await page.waitForTimeout(300)
}
await openCustom()
// builtins + 新建操作 are offered inside custom
const summaryOp = page.locator('button:has-text("总结")')
const guideOp = page.locator('button:has-text("生成学习指南")')
assert(await page.locator('button:has-text("总结")').count() >= 1, 'custom surface offers the builtin 总结 preset')
assert(await page.locator('button:has-text("生成学习指南")').count() >= 1, 'custom surface offers the builtin 学习指南 preset')
// select the builtin 总结, then 另存为 a custom action
await page.locator('button:has-text("总结")').first().click()
await page.waitForTimeout(200)
await page.locator('input[aria-label="操作名称"]').fill('我的总结')
await page.locator('textarea[aria-label="提示词"]').fill('请总结为 100 字。')
await page.locator('button:has-text("保存为操作")').click()
await page.waitForTimeout(700)
assert(await page.locator('button:has-text("我的总结")').count() >= 1, '另存为 action appears in the op list (builtin -> create)')
// reset to 新建操作 to clear the selection, then reload to check persistence
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
await page.reload({ waitUntil: 'networkidle' })
await page.locator('[data-testid="composer-materials-input"]').waitFor({ state: 'attached', timeout: 20000 })
await openCustom()
assert(await page.locator('button:has-text("我的总结")').count() >= 1, '另存为 custom action survives a reload (persisted)')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length && pageErrors === '(none)' ? 0 : 1)

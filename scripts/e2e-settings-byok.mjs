// BYOK settings onboarding e2e (commit 3): desktop dialog width, BYOK explanation,
// DeepSeek platform link, responsive no-overflow at 360px, editable fields.
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await page.locator('[data-testid="sidebar-settings"]').click()
await page.getByText('设置').first().waitFor({ state: 'visible', timeout: 10000 }).catch(()=>{})

// desktop width >= 560 and <= viewport
const dialog = await page.evaluate(() => {
  const d = document.querySelector('[role="dialog"]')
  if (!d) return null
  const r = d.getBoundingClientRect()
  return { w: r.width, h: r.height }
})
assert(dialog && dialog.w >= 560, 'desktop settings dialog width >= 560px (got ' + (dialog ? Math.round(dialog.w) : 'none') + ')')
assert(dialog && dialog.w <= 1440, 'desktop settings dialog <= viewport')

// BYOK explanation visible
assert(await page.locator('[data-testid="settings-byok"]').count() === 1, 'BYOK explanation block shown')

// DeepSeek platform link attributes
const link = await page.locator('[data-testid="settings-deepseek-link"]').evaluate(a => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') }))
assert(link.href === 'https://platform.deepseek.com/', 'DeepSeek link href (got ' + link.href + ')')
assert(link.target === '_blank', 'DeepSeek link target=_blank')
assert(link.rel && link.rel.includes('noopener'), 'DeepSeek link rel contains noopener')

// fields editable
const apiUrl = page.locator('input[placeholder="https://api.deepseek.com"]')
const keyInput = page.locator('input[placeholder="sk-..."]')
assert(await apiUrl.count() >= 1 && await keyInput.count() >= 1, 'API Base URL + Key fields present')
await apiUrl.first().fill('https://api.deepseek.com')
assert((await apiUrl.first().inputValue()) === 'https://api.deepseek.com', 'API Base URL editable')

// 360px no horizontal overflow
await page.setViewportSize({ width: 360, height: 800 })
await page.waitForTimeout(300)
const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)
assert(noOverflow, '360px settings no horizontal overflow')

await browser.close()
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)

// Mobile history drawer e2e for the v1.3.0 release gate.
// Covers both requested phone sizes and verifies that the conversation remains
// usable while the drawer is open.
import { launchBrowser } from './e2e-browser.mjs'

const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

const browser = await launchBrowser()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await ctx.newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('dialog', d => { void d.accept() })

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('[data-testid="mobile-history"]').waitFor({ state: 'visible', timeout: 25000 })

const measure = () => page.evaluate(() => ({
  viewport: document.documentElement.clientWidth,
  scrollWidth: document.documentElement.scrollWidth,
  drawerWidth: document.querySelector('[data-testid="mobile-history-drawer"]')?.getBoundingClientRect().width ?? 0,
}))
const noHorizontalOverflow = async (label) => {
  const m = await measure()
  assert(m.scrollWidth <= m.viewport + 1, label + ': no horizontal overflow (' + m.scrollWidth + '/' + m.viewport + ')')
  return m
}

for (const size of [{ width: 390, height: 844 }, { width: 375, height: 812 }]) {
  await page.setViewportSize(size)
  await page.waitForTimeout(150)
  const label = size.width + 'x' + size.height
  assert(await page.locator('[data-testid="mobile-history-drawer"]').count() === 0, label + ': drawer starts closed')
  await noHorizontalOverflow(label + ' closed')

  await page.locator('[data-testid="mobile-history"]').click()
  const open = await page.locator('[data-testid="mobile-history-drawer"]').waitFor({ state: 'visible' }).then(() => measure())
  assert(open.drawerWidth > 0 && open.drawerWidth <= Math.min(240, size.width * 0.72) + 1, label + ': drawer width fits min(240px,72vw)')
  await noHorizontalOverflow(label + ' open')
  assert(await page.locator('[data-testid="conversation"]').count() > 0, label + ': conversation remains mounted')

  await page.locator('[data-testid="mobile-history-backdrop"]').click({ position: { x: 20, y: 20 } })
  await page.locator('[data-testid="mobile-history-drawer"]').waitFor({ state: 'hidden' })
  assert(true, label + ': backdrop closes drawer')

  await page.locator('[data-testid="mobile-history"]').click()
  await page.locator('[data-testid="mobile-history-drawer"]').waitFor({ state: 'visible' })
  await page.locator('[data-testid="sidebar-collapse"]').click()
  await page.locator('[data-testid="mobile-history-drawer"]').waitFor({ state: 'hidden' })
  assert(true, label + ': drawer header closes drawer')

  await page.locator('[data-testid="mobile-history"]').click()
  await page.locator('[data-testid="mobile-history-drawer"]').waitFor({ state: 'visible' })
  await page.locator('[data-testid="history-session"]').first().click()
  await page.locator('[data-testid="mobile-history-drawer"]').waitFor({ state: 'hidden' })
  assert(true, label + ': selecting a session closes drawer')
  await noHorizontalOverflow(label + ' after select')
}

await browser.close()
for (const line of results) console.log(line)
for (const error of errors) console.error(error)
if (errors.length || results.some(line => line.startsWith('FAIL'))) process.exitCode = 1
console.log('\nRESULT ' + results.filter(line => line.startsWith('PASS')).length + '/' + results.length + ' passed')

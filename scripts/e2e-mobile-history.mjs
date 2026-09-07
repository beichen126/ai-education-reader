// Mobile history drawer e2e for the v1.3.1 release gate.
// Covers the requested phone sizes and verifies that the conversation and its
// unsent draft remain usable while the drawer is open.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'

const CONVERSATION_A = 'stage4b-conversation-a'
const CONVERSATION_B = 'stage4b-conversation-b'
const A_TITLE = 'Stage4B Conversation A'
const B_TITLE = 'Stage4B Conversation B'
const A_ONLY = 'A_ONLY_MESSAGE'
const B_ONLY = 'B_ONLY_MESSAGE'
const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

const browser = await launchBrowser()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await ctx.newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('dialog', d => { void d.accept() })

const now = Date.now()
const conversationA = {
  id: CONVERSATION_A,
  title: A_TITLE,
  createdAt: now,
  updatedAt: now,
  messages: [msg('stage4b-a-only-message', 'user', A_ONLY)],
}
const conversationB = {
  id: CONVERSATION_B,
  title: B_TITLE,
  createdAt: now + 1,
  updatedAt: now + 1,
  messages: [msg('stage4b-b-only-message', 'user', B_ONLY)],
}

// seedAndBoot waits for a sidebar title as its hydration signal. At a narrow
// viewport the history drawer is intentionally closed, so seed at desktop
// width and restore the first requested mobile viewport before assertions.
await page.setViewportSize({ width: 1440, height: 900 })
await seedAndBoot(page, {
  convs: [conversationA, conversationB],
  settings: { lastConversationId: CONVERSATION_A },
})
await page.setViewportSize({ width: 390, height: 844 })
await page.locator('[data-testid="rail-history"]').waitFor({ state: 'visible', timeout: 25000 })
const composer = page.locator('textarea[class*="composerText"]')
await composer.waitFor({ state: 'visible', timeout: 10000 })
const aOnly = page.getByText(A_ONLY, { exact: true })
const bOnly = page.getByText(B_ONLY, { exact: true })
await aOnly.waitFor({ state: 'visible', timeout: 10000 })
assert(await bOnly.count() === 0, 'initial state: A is current and B-only content is absent')
assert(await aOnly.count() > 0, 'initial state: A-only content is visible')

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

for (const size of [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
]) {
  await page.setViewportSize(size)
  await page.waitForTimeout(150)
  const label = size.width + 'x' + size.height
  assert(await page.locator('[data-testid="mobile-history-drawer"]').count() === 0, label + ': drawer starts closed')
  await noHorizontalOverflow(label + ' closed')

  const draft = '移动抽屉回归草稿 ' + label
  await composer.fill(draft)
  await page.locator('[data-testid="rail-history"]').click()
  const drawer = page.locator('[data-testid="mobile-history-drawer"]')
  const open = await drawer.waitFor({ state: 'visible' }).then(() => measure())
  assert(open.drawerWidth > 0 && open.drawerWidth <= Math.min(240, size.width * 0.72) + 1, label + ': drawer width fits min(240px,72vw)')
  await noHorizontalOverflow(label + ' open')
  assert(await page.locator('[data-testid="conversation"]').count() > 0, label + ': conversation remains mounted')
  assert(await composer.inputValue() === draft, label + ': draft remains while drawer is open')
  assert(await drawer.getAttribute('role') === 'navigation', label + ': drawer exposes role=navigation')
  assert(await drawer.getAttribute('aria-label') === '主导航', label + ': drawer exposes aria-label=主导航')

  await page.locator('[data-testid="mobile-history-backdrop"]').click({ position: { x: 20, y: 20 } })
  await page.locator('[data-testid="mobile-history-drawer"]').waitFor({ state: 'hidden' })
  assert(true, label + ': backdrop closes drawer')
  assert(await composer.inputValue() === draft, label + ': draft remains after backdrop close')

  await page.locator('[data-testid="rail-history"]').click()
  await drawer.waitFor({ state: 'visible' })
  await page.locator('[data-testid="sidebar-collapse"]').click()
  await drawer.waitFor({ state: 'hidden' })
  assert(true, label + ': drawer header closes drawer')
  assert(await composer.inputValue() === draft, label + ': draft remains after header close')

  // Keep the existing session-selection coverage, but identify the target by
  // its unique title. At 390px this is the required A -> B behavior chain.
  await page.locator('[data-testid="rail-history"]').click()
  await drawer.waitFor({ state: 'visible' })
  const targetTitle = size.width === 390 ? B_TITLE : A_TITLE
  const target = drawer.locator('[data-testid="history-session"]').filter({ hasText: targetTitle })
  assert(await target.count() === 1, label + ': unique target session is present (' + targetTitle + ')')
  await target.click()
  await drawer.waitFor({ state: 'hidden' })
  assert(true, label + ': selecting a session closes drawer')
  if (size.width === 390) {
    await bOnly.waitFor({ state: 'visible', timeout: 10000 })
    await page.waitForFunction(() => !document.body.innerText.includes('A_ONLY_MESSAGE'), null, { timeout: 10000 })
    assert(await bOnly.count() > 0, label + ': B-only content is visible after selecting B')
    assert(await aOnly.count() === 0, label + ': A-only content is no longer current after selecting B')

    // Restore A explicitly so the next viewport keeps the original draft
    // scenario independent of the cross-conversation assertion above.
    await page.locator('[data-testid="rail-history"]').click()
    await drawer.waitFor({ state: 'visible' })
    const restoreA = drawer.locator('[data-testid="history-session"]').filter({ hasText: A_TITLE })
    assert(await restoreA.count() === 1, label + ': A restore target is unique')
    await restoreA.click()
    await drawer.waitFor({ state: 'hidden' })
    await aOnly.waitFor({ state: 'visible', timeout: 10000 })
    assert(await aOnly.count() > 0, label + ': A content returns after explicit restore')
  }
  await noHorizontalOverflow(label + ' after select')
}

await browser.close()
for (const line of results) console.log(line)
for (const error of errors) console.error(error)
if (errors.length || results.some(line => line.startsWith('FAIL'))) process.exitCode = 1
console.log('\nRESULT ' + results.filter(line => line.startsWith('PASS')).length + '/' + results.length + ' passed')

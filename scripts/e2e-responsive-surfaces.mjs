import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot } from './e2e-fixture.mjs'
import { openProductGuide, openSettings, openDocumentLibrary, selectSettingsSection } from './e2e-navigation.mjs'
const browser = await launchBrowser()
const base = process.env.E2E_BASE || 'http://127.0.0.1:5321/ai-education-reader/'
const sizes = [[320,640],[390,844],[600,800],[768,1024],[820,640],[1024,768],[1280,800]]
async function inside(page, locator) {
  for (const el of await locator.all()) {
    if (!await el.isVisible()) continue
    const b = await el.boundingBox(), v = page.viewportSize()
    assert.ok(b && b.x >= -1 && b.y >= -1 && b.x + b.width <= v.width + 1 && b.y + b.height <= v.height + 1, 'control outside viewport: ' + JSON.stringify(b))
  }
}
try {
  for (const language of ['zh-CN','en']) {
    const context = await browser.newContext()
    const page = await context.newPage()
    await seedAndBoot(page, {settings:{uiLanguage:language}})
    await openProductGuide(page)
    for (const [width,height] of sizes) {
      await page.setViewportSize({width,height})
      await inside(page, page.getByTestId('product-guide').locator('header button, footer button, [aria-label="开始使用"] button, [aria-label="Get started"] button'))
      assert.ok(await page.getByTestId('product-guide-scroll').evaluate(el => el.clientHeight > 60 && el.scrollHeight > el.clientHeight && el.scrollWidth <= el.clientWidth + 1))
      await page.getByTestId('product-guide-scroll').evaluate(el => {el.scrollTop=el.scrollHeight})
      await inside(page, page.getByTestId('product-guide-later'))
      if(language==='zh-CN' && [390,768].includes(width)) await page.screenshot({path:`test-results/responsive-guide-${width}.png`})
    }
    await page.getByTestId('product-guide-close').click()
    await openSettings(page,'help')
    for (const [width,height] of sizes) {
      await page.setViewportSize({width,height})
      const links = page.locator('[data-testid="settings-user-guide"]').locator('..').locator(':scope > *')
      await links.first().scrollIntoViewIfNeeded()
      const boxes=await links.evaluateAll(els=>els.map(el=>({w:el.getBoundingClientRect().width,h:el.getBoundingClientRect().height})))
      assert.equal(boxes.length,3)
      assert.ok(boxes.every(b=>Math.abs(b.w-boxes[0].w)<1 && Math.abs(b.h-boxes[0].h)<1),'help links must have equal dimensions')
      await inside(page,links)
    }
    await selectSettingsSection(page,'general')
    const headings = await page.locator('#settings-section-general > div > div:first-child').allTextContents()
    assert.deepEqual(headings,language==='zh-CN' ? ['外观','PDF 阅读方式','提示词管理','对话阅读位置','界面语言','朗读倍速'] : ['Appearance','PDF reading mode','Prompt management','Conversation reading position','Interface language','Read aloud speed'])
    assert.equal(await page.getByTestId('settings-remember-reading-position').isChecked(),true)
    await page.keyboard.press('Escape')
    await openDocumentLibrary(page)
    for (const [width,height] of sizes) {await page.setViewportSize({width,height});await inside(page,page.getByTestId('document-library').locator('button[data-testid="library-import"],button[data-testid="library-close"],select'))}
    await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles('test/fixtures/outline-sample.pdf')
    await page.getByTestId('document-reader').waitFor({timeout:40000})
    for (const [width,height] of sizes) {
      await page.setViewportSize({width,height})
      await inside(page,page.getByTestId('document-reader').locator('[data-testid="reader-back"], [data-testid="reader-ctx-toggle"], [data-testid="reader-related-toggle"], [data-testid="reader-toc-toggle"], [data-testid="reader-notes-toggle"], [data-testid="reader-close"]'))
      if(language==='zh-CN' && [390,768].includes(width))await page.screenshot({path:`test-results/responsive-reader-${width}.png`})
    }
    await context.close()
  }
  const android = await browser.newContext({viewport:{width:390,height:844}})
  await android.route('https://appassets.androidplatform.net/**', async route => {
    const url=new URL(route.request().url())
    await route.fulfill({response:await route.fetch({url:new URL(url.pathname,base).href})})
  })
  const page=await android.newPage()
  process.env.E2E_BASE='https://appassets.androidplatform.net/ai-education-reader/'
  await seedAndBoot(page,{})
  assert.equal(await page.locator('[data-testid="header-fullscreen"]').count(),0)
  await page.getByTestId('mobile-menu-toggle').click()
  assert.equal(await page.locator('[data-testid="sidebar-fullscreen"], [data-testid="rail-fullscreen"], [data-testid="help-product-guide"], [data-testid="rail-help"]').count(),0)
  await android.close()
  const web=await browser.newContext()
  await web.route('https://beichen126.github.io/**',async route=>{const u=new URL(route.request().url());await route.fulfill({response:await route.fetch({url:new URL(u.pathname,base).href})})})
  await web.route('http://127.0.0.1:8091/**',route=>route.fulfill({status:401,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'https://beichen126.github.io'},body:'{"error":{"code":"pairing_required"}}'}))
  const config=await web.newPage();process.env.E2E_BASE='https://beichen126.github.io/ai-education-reader/'
  await seedAndBoot(config,{})
  await openSettings(config,'api')
  const provider=config.getByRole('combobox',{name:'对话 Provider',exact:true})
  await config.locator('input[placeholder="sk-..."]').fill('mock-unsaved-key')
  assert.equal(await config.getByTestId('openai-provider-controls').count(),0)
  await provider.selectOption('openai-local')
  await config.getByTestId('openai-provider-controls').waitFor()
  assert.equal(await config.getByTestId('settings-byok').count(),0)
  assert.equal(await config.locator('input[placeholder="sk-..."]').count(),0)
  await provider.selectOption('deepseek')
  await config.getByTestId('settings-byok').waitFor()
  assert.equal(await config.locator('input[placeholder="sk-..."]').inputValue(),'mock-unsaved-key')
  assert.equal(await config.getByTestId('openai-provider-controls').count(),0)
  await web.close()
  console.log('PASS: guide scroll, equal Help actions, library/reader toolbars across 320–1280px in Chinese/English; Android fullscreen and sidebar Help absent')
} finally {process.env.E2E_BASE=base;await browser.close()}

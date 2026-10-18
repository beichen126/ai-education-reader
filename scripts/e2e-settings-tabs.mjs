import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot } from './e2e-fixture.mjs'
import { openSettings, selectSettingsSection } from './e2e-navigation.mjs'

const browser = await launchBrowser()
try {
  for (const [language,width,height] of [['zh-CN',1280,900],['zh-CN',390,740],['en',320,640]]) {
    const context=await browser.newContext({viewport:{width,height}})
    const page=await context.newPage(), errors=[]
    page.on('pageerror',error=>errors.push(error.message))
    await seedAndBoot(page,{settings:{uiLanguage:language}})
    await openSettings(page,'api')
    const panels=page.getByRole('tabpanel')
    assert.equal(await panels.count(),1,'only the selected settings panel is accessible')
    assert.equal(await page.locator('#settings-section-api').isVisible(),true)
    assert.equal(await page.locator('[data-testid="settings-pdf-navigation"]').isVisible(),false)
    const key=page.locator('input[placeholder="sk-..."]')
    await key.fill('unsaved-tab-draft')
    const scroller=page.locator('[data-testid="settings-panel-scroll"]')
    await selectSettingsSection(page,'general')
    assert.equal(await panels.count(),1)
    assert.equal(await key.isVisible(),false)
    assert.equal(await page.locator('[data-testid="data-safety-center"]').isVisible(),false)
    await selectSettingsSection(page,'security')
    assert.equal(await page.locator('[data-testid="data-safety-center"]').isVisible(),true)
    const nav=page.getByRole('tablist'), before=await nav.boundingBox()
    await scroller.evaluate(el=>{el.scrollTop=el.scrollHeight})
    const after=await nav.boundingBox()
    assert.equal(before.y,after.y,'tabs do not scroll with the panel content')
    await selectSettingsSection(page,'help')
    assert.equal(await page.locator('[data-testid="settings-help-content"] article').count(),5,'help provides readable bilingual instructions, not just links')
    assert.equal(await page.locator('[data-testid="settings-help-content"]').isVisible(),true)
    assert.equal(await scroller.evaluate(el=>el.scrollTop),0,'switching panels starts at the top')
    assert.equal(await page.locator('[data-testid="data-safety-center"]').isVisible(),false)
    await selectSettingsSection(page,'api')
    assert.equal(await key.inputValue(),'unsaved-tab-draft','tab switches do not discard or save the API draft')
    await page.locator('[data-testid="settings-nav-api"]').focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.locator('[data-testid="settings-nav-general"]').getAttribute('aria-selected'),'true')
    await page.keyboard.press('End')
    assert.equal(await page.locator('[data-testid="settings-nav-help"]').getAttribute('aria-selected'),'true')
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    assert.deepEqual(errors,[])
    console.log('PASS settings tabs '+language+'/'+width+'px: independent panels, stable header, reset scrolling, preserved API draft and keyboard navigation')
    await context.close()
  }
} finally {await browser.close()}

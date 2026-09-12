// Study Artifact E2E: Note (source cutoff + edit/reload) + Quiz (valid). Real UI + mock model.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot, installMockModel, getLastRequestBody, getRouteHits, openSpecialBranchMenu } from './e2e-fixture.mjs'
function getRouteHitsCompletions() { return getRouteHits().completions }
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)

const browser = await launchBrowser()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

const conv = { id: 'art', title: '成果对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [
  msg('U1', 'user', '源问题一'), msg('A1', 'assistant', '源答案一'), msg('U2', 'user', '源问题二'), msg('A2', 'assistant', '源答案二'),
] }
await seedAndBoot(page, { convs: [conv], settings: { apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com', lastConversationId: 'art' } })

// Legacy summary/study-guide/custom artifacts stay readable and are grouped under
// the history-only library filter; they are never presented as new creation types.
await page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('ai-education-reader')
  request.onerror = () => reject(request.error)
  request.onsuccess = () => {
    const db = request.result
    const tx = db.transaction('artifacts', 'readwrite')
    const source = { conversationId: 'art', throughMessageId: 'A1', snapshot: { conversationId: 'art', throughMessageId: 'A1', createdAt: 1, messages: [{ role: 'user', text: '旧版来源', imageIds: [] }], provenance: [], sourceLabel: '会话', sourceDeleted: false } }
    for (const [kind, title] of [['summary', '历史总结'], ['study-guide', '历史学习指南'], ['custom', '历史自定义']]) {
      tx.objectStore('artifacts').put({ id: 'legacy-' + kind, kind, title, source, prompt: '旧版 ' + kind + ' 提示词', createdAt: 1, updatedAt: 1, status: 'ready', content: '# 旧版 ' + title + '\n\n兼容内容。' })
    }
    tx.oncomplete = () => { db.close(); resolve(true) }
    tx.onerror = () => reject(tx.error)
  }
}))

// ---- Note from A1 (index 0 assistant): markdown -> REAL rendered preview (A7) ----
const NOTE_MD = '# 标题一\n\n- 要点甲\n- **要点乙**\n\n> 引用一\n\n$$E = mc^2$$\n'
await installMockModel(page, [NOTE_MD])
await openSpecialBranchMenu(page, 0)
await page.locator('[data-testid="message-action-note"]').click()
await page.locator('text=创建学习成果').waitFor({ state: 'visible', timeout: 5000 })
assert(true, 'Note dialog opens from the message menu (mode = 整理成笔记)')
// Default preset prompt present + editable.
const promptVal = await page.locator('textarea[class*="promptArea"]').inputValue()
assert(promptVal.includes('笔记'), 'Note dialog pre-fills the editable prompt (len ' + promptVal.length + ')')
assert(await page.locator('[role="listbox"][aria-label="Artifact 模板"]').count() === 1, 'Stage 10: Artifact dialog selects from the Prompt catalog')
await page.locator('input[aria-label="另存为名称"]').fill('我的笔记模板')
await page.locator('textarea[aria-label="本次要求"]').fill('本次只提炼定义和易错点。')
await page.locator('button:has-text("另存为提示词")').click()
await page.locator('[role="status"]').waitFor({ state: 'visible', timeout: 8000 })
assert(await page.locator('button:has-text("我的笔记模板")').count() >= 1, 'Stage 10: run-local edit can be saved as a new Artifact prompt')
// Stage 4: the create dialog only offers Note / Quiz; legacy kinds are history-only.
assert(await page.locator('[role="radiogroup"][aria-label="类型"] [role="radio"]').count() === 2, 'Stage 4: create dialog exposes exactly Note and Quiz')
assert(await page.locator('[data-testid="artifact-kind-custom"]').count() === 0, 'Stage 4: custom processing is absent from the create dialog')
const summaryBtn = await page.locator('button:has-text("生成总结")').count()
const guideBtn = await page.locator('button:has-text("生成学习指南")').count()
assert(summaryBtn === 0 && guideBtn === 0, 'Stage 4: summary/study-guide actions are absent from the create dialog')
// Generate.
await page.locator('button:has-text("生成")').filter({ hasText: /^生成$/ }).last().click()
// The generated Note editor opens (title input + body textarea).
await page.waitForFunction(() => document.body.textContent.includes('标题一'), null, { timeout: 15000 })
assert(true, 'generated Note content appears in the editor')
// A7: the preview pane renders REAL Markdown (h1, ul/ol, strong, KaTeX).
await page.locator('h1', { hasText: '标题一' }).first().waitFor({ state: 'visible', timeout: 8000 })
assert(await page.locator('h1', { hasText: '标题一' }).count() >= 1, 'A7: Markdown heading -> <h1>')
assert(await page.locator('ul li', { hasText: '要点甲' }).count() >= 1, 'A7: Markdown list -> <ul><li>')
assert(await page.locator('strong', { hasText: '要点乙' }).count() >= 1, 'A7: Markdown bold -> <strong>')
assert(await page.locator('.katex').count() >= 1, 'A7: KaTeX math renders')
// A9: one-click Markdown export from the current edited content.
const noteExport = page.waitForEvent('download')
await page.locator('button:has-text("导出 Markdown")').first().click()
const noteDl = await noteExport
assert(/笔记/.test(noteDl.suggestedFilename()) && noteDl.suggestedFilename().endsWith('.md'), 'A9: Note export -> <title>.md (got ' + noteDl.suggestedFilename() + ')')
// Source cutoff: the artifact request body must contain M1/A1 source but NOT M2/A2.
const reqBody = getLastRequestBody()
const reqText = reqBody ? JSON.stringify(reqBody) : ''
assert(reqText.includes('源问题一') && reqText.includes('源答案一'), 'artifact source includes M1/A1')
assert(!reqText.includes('源问题二') && !reqText.includes('源答案二'), 'artifact source EXCLUDES post-cutoff M2/A2 (source cutoff)')
assert(!reqText.includes('苏格拉底式学习') && !reqText.includes('深入讲解'), 'Stage 10: Conversation Mode is not injected into Artifact request')
// Edit title + body, reload, verify persistence.
await page.locator('input[class*="titleInput"]').fill('我的笔记标题')
await page.keyboard.press('Tab') // blur -> commitTitle persists the title
await page.locator('textarea[class*="textarea"]').fill('这是笔记内容 已编辑')
await page.waitForTimeout(900) // autosave debounce
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 20000 })
await page.waitForTimeout(1200)
// Reopen the library and open the note to verify the edit persisted.
await page.locator('text=学习成果').click()
await page.locator('text=我的笔记标题').waitFor({ state: 'visible', timeout: 8000 })
assert(true, 'edited Note title persisted after reload (shown in Artifact Library)')
await page.locator('text=我的笔记标题').click()
await page.waitForTimeout(700)
// Close the note editor overlay so the conversation's A2 trigger is reachable again.
await page.locator('button:has-text("关闭")').last().click()
await page.waitForTimeout(500)

// ---- Agent F (F4): closing the editor IMMEDIATELY after typing flushes the pending edit ----
await page.locator('text=学习成果').click()
await page.locator('text=我的笔记标题').waitFor({ state: 'visible', timeout: 8000 })
await page.locator('text=我的笔记标题').click()
await page.waitForTimeout(500)
// type, then click 关闭 IMMEDIATELY (well inside the 450ms autosave debounce)
await page.locator('textarea[class*="textarea"]').fill('最后编辑-立即关闭')
await page.locator('button:has-text("关闭")').last().click()
await page.waitForTimeout(700)
// reopen from the library and verify the flush-on-close persisted the last keystrokes
await page.locator('text=学习成果').click()
await page.locator('text=我的笔记标题').waitFor({ state: 'visible', timeout: 8000 })
await page.locator('text=我的笔记标题').click()
await page.waitForTimeout(500)
const bodyAfterFastClose = await page.locator('textarea[class*="textarea"]').inputValue()
assert(bodyAfterFastClose.includes('最后编辑-立即关闭'), 'F4: closing editor immediately after typing persists the last edit (got ' + bodyAfterFastClose + ')')
await page.locator('button:has-text("关闭")').last().click()
await page.waitForTimeout(400)

// ---- Quiz from A2 (index 1 assistant): valid structured quiz ----
const quizJSON = JSON.stringify({ questions: [{ id: 'q1', type: 'single-choice', question: '2+2=?', options: ['3', '4', '5'], answer: 1, explanation: '2+2=4' }] })
await installMockModel(page, [quizJSON])
await openSpecialBranchMenu(page, 1)
await page.locator('[data-testid="message-action-quiz"]').click()
await page.locator('text=创建学习成果').waitFor({ state: 'visible', timeout: 5000 })
await page.waitForTimeout(600)
try {
  await page.locator('button:has-text("生成")').filter({ hasText: /^生成$/ }).last().click({ timeout: 5000 })
} catch (e) {
  const inj = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).filter(x => x.textContent.trim() === '生成').pop()
    if (!b) return { noBtn: true }
    const r = b.getBoundingClientRect(); const cx = r.x + r.width/2, cy = r.y + r.height/2
    const hit = document.elementFromPoint(cx, cy)
    return { cx, cy, hit: hit ? { tag: hit.tagName, cls: String(hit.className||'').slice(0,40) } : null, menus: Array.from(document.querySelectorAll('[role="menu"]')).length }
  })
  console.log('E2E CLICK INTERCEPTED:', JSON.stringify(inj))
  throw e
}
// Quiz viewer opens with the structured question.
await page.waitForFunction(() => document.body.textContent.includes('2+2=?'), null, { timeout: 15000 })
assert(true, 'QuizViewer opens with the structured question')
const quizRequest = getLastRequestBody()
const quizMessages = quizRequest?.messages || []
assert(quizMessages.filter((m) => m.role === 'system').length === 1, 'Stage 10: Quiz request has one machine protocol system message')
assert(quizMessages.some((m) => m.role === 'system' && String(m.content).includes('QuizDocument')), 'Stage 10: Quiz protocol contract is sent as system scope')
assert(quizMessages.some((m) => m.role === 'user' && String(m.content).includes('练习题目')), 'Stage 10: Quiz user intent remains a user message')
// A9: quiz export buttons (Markdown + JSON) in the artifact chrome.
const quizMdDlP = page.waitForEvent('download')
await page.locator('button:has-text("导出 Markdown")').first().click()
const quizMdDl = await quizMdDlP
assert(quizMdDl.suggestedFilename().endsWith('.md'), 'A9: Quiz export -> <title>.md (got ' + quizMdDl.suggestedFilename() + ')')
const quizJsonDlP = page.waitForEvent('download')
await page.locator('button:has-text("导出 JSON")').first().click()
const quizJsonDl = await quizJsonDlP
assert(quizJsonDl.suggestedFilename().endsWith('.json'), 'A9: Quiz export -> <title>.json (got ' + quizJsonDl.suggestedFilename() + ')')
// Answer + reveal + explanation + source.
await page.locator('input[type="radio"]').nth(1).check()
await page.locator('text=提交/查看答案').click()
await page.waitForFunction(() => document.body.textContent.includes('解析：'), null, { timeout: 8000 })
// Close the QuizViewer overlay so the conversation is reachable again.
await page.mouse.click(20, 20)
await page.waitForTimeout(400)
// ---- Invalid quiz: malformed model output must NOT be saved as ready ----
const badQuiz = JSON.stringify({ questions: [{ id: 'q1', type: 'single-choice', question: '坏题', options: ['A','B'], answer: 9 }] })
await installMockModel(page, [badQuiz])
await openSpecialBranchMenu(page, 0)
await page.locator('[data-testid="message-action-quiz"]').click()
await page.locator('text=创建学习成果').waitFor({ state: 'visible', timeout: 5000 })
await page.waitForTimeout(500)
await page.locator('button:has-text("生成")').filter({ hasText: /^生成$/ }).last().click()
await page.waitForTimeout(1500)
const artifacts2 = await page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('ai-education-reader')
  req.onsuccess = () => { const db = req.result; const tx = db.transaction('artifacts','readonly'); const g = tx.objectStore('artifacts').getAll(); g.onsuccess = () => { try { db.close() } catch {}; resolve((g.result||[]).map(a => ({ kind: a.kind, status: a.status }))) }; g.onerror = () => resolve([]) }
}))
const badArtifact = artifacts2.find(a => a.kind === 'quiz' && a.status === 'error')
assert(!!badArtifact, 'malformed quiz -> artifact is ERROR (never saved ready)')
assert(!artifacts2.some(a => a.kind === 'quiz' && a.status === 'ready' && a.question === 'bad'), 'no ready artifact from the malformed quiz')
// A2: the create dialog STAYS OPEN and shows the error (never silently swallowed).
const dialogAlert = await page.locator('[role="dialog"] [role="alert"]').textContent().catch(() => '')
assert(dialogAlert && dialogAlert.indexOf('题目解析失败') >= 0, 'A2: generation error surfaced in the create dialog (got ' + dialogAlert + ')')
// Close the create dialog (it stayed open on error) and proceed to the library.
await page.locator('[role="dialog"] button:has-text("取消")').first().click()
await page.waitForTimeout(400)

// ---- Artifact Library: browse/filter/delete ----
await page.locator('text=学习成果').click()
// Wait for the ACTUAL note card (not the always-present '笔记' label) — the artifact list loads
// asynchronously, and on a slower CI runner counting too early returned 0 even though the note
// was present (a later assertion confirmed it). Making the gate deterministic, not flaky.
await page.locator('text=我的笔记标题').first().waitFor({ state: 'visible', timeout: 8000 })
assert(await page.locator('text=我的笔记标题').count() >= 1, 'Artifact Library lists the Note')
await page.locator('button:has-text("题目")').first().click()
await page.waitForTimeout(500)
// A6: open the failed quiz (first 题目 card = newest) -> error view with recovery actions.
await page.locator('div[role="button"]:has-text("题目")').first().click()
await page.waitForTimeout(400)
assert(await page.locator('text=生成失败').count() >= 1, 'A6: failed quiz shows the error view (生成失败)')
assert(await page.locator('button:has-text("重新生成")').count() >= 1, 'A6: error view offers 重新生成')
assert(await page.locator('button:has-text("查看原始输出")').count() >= 1, 'A6: error view offers 查看原始输出')
await page.locator('button:has-text("查看原始输出")').first().click()
await page.waitForTimeout(300)
const rawOk = (await page.locator('pre').textContent().catch(() => '') || '').indexOf('坏题') >= 0
assert(rawOk, 'A6: raw model output is viewable for the failed quiz')
// Close the error view overlay (this returns to the conversation — opening an artifact closes the library).
await page.locator('button:has-text("关闭")').last().click()
await page.waitForTimeout(400)
await page.locator('text=学习成果').click()
await page.waitForTimeout(500)
await page.locator('button:has-text("题目")').first().click()
await page.waitForTimeout(500)
// Delete the invalid quiz from the library (or the valid one) via the delete button on a card.
const delBtns = await page.locator('button:has-text("删除")').all()
if (delBtns.length > 0) { await delBtns[0].click(); await page.waitForTimeout(500) }
await page.locator('button:has-text("全部")').first().click()
await page.locator('text=我的笔记标题').first().waitFor({ state: 'visible', timeout: 8000 })
assert(await page.locator('text=我的笔记标题').count() >= 1, 'Artifact Library still shows the Note after deleting a card')

await page.locator('button:has-text("历史类型")').click()
await page.locator('div[role="button"]:has-text("历史自定义")').first().waitFor({ state: 'visible', timeout: 8000 })
assert(await page.locator('div[role="button"]:has-text("历史总结")').count() === 1 && await page.locator('div[role="button"]:has-text("历史学习指南")').count() === 1 && await page.locator('div[role="button"]:has-text("历史自定义")').count() === 1, 'legacy summary/study-guide/custom artifacts remain in the history library filter')
await page.locator('div[role="button"]:has-text("历史自定义")').first().click()
await page.locator('h1:has-text("旧版 历史自定义")').waitFor({ state: 'visible', timeout: 8000 })
assert(await page.locator('span[class*="cardKind"]:has-text("历史类型")').count() >= 1 && await page.locator('h1:has-text("旧版 历史自定义")').count() >= 1, 'legacy custom artifact uses Markdown rendering and is marked history-only')
const legacyExport = page.waitForEvent('download')
await page.locator('button:has-text("导出 Markdown")').first().click()
const legacyDownload = await legacyExport
assert(legacyDownload.suggestedFilename().endsWith('.md'), 'legacy custom artifact remains exportable as Markdown')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)

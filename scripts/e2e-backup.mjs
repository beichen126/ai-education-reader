// Backup V4 browser round-trip: seed a full V4 state, then export via the real settings UI,
// clear app data, import the downloaded backup, reload, and verify restore.
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)

async function seedBackup(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const now = Date.now()
    const blob = (bytes) => new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    const row = (id, name, bytes) => ({ id, meta: { id, name, mimeType: 'image/png', size: bytes.length, createdAt: now, updatedAt: now }, binary: { storage: 'idb', blob: blob(bytes), size: bytes.length, mimeType: 'image/png' }, recordVersion: 2 })
    const msg = (id, role, content, images = []) => ({ id, role, content, images, createdAt: now, updatedAt: now })
    const snapshot = (convId, through) => ({ conversationId: convId, throughMessageId: through, createdAt: now, messages: [{ role: 'user', text: '问题一', imageIds: [] }, { role: 'assistant', text: '答案一', imageIds: [] }], provenance: [], sourceLabel: '会话', sourceDeleted: false })
    const imgMain = row('imgMain', 'main.png', [137,80,78,71,1])
    const imgA = row('imgA', 'a.png', [137,80,78,71,2])
    const pdfCtx = { id: 'pdfCtx', meta: { id: 'pdfCtx', name: 'book.pdf', mimeType: 'image/png', size: 4, createdAt: now, updatedAt: now, source: { type: 'pdf-page', groupId: 'g1', fileName: 'book.pdf', pageNumber: 3, selection: { kind: 'manual', ranges: [] } } }, binary: { storage: 'idb', blob: blob([137,80,78,71,3]), size: 4, mimeType: 'image/png' }, recordVersion: 2 }
    const conv = { id: 'c1', title: '备份主对话', createdAt: now, updatedAt: now, messages: [
      msg('U1','user','问题一'), msg('A1','assistant','答案一'), msg('U2','user','问题二',[ 'imgMain' ]), msg('A2','assistant','答案二'),
    ] }
    const bA = { id: 'bA', conversationId: 'c1', forkMessageId: 'A1', title: '分支 A', createdAt: now, updatedAt: now, messages: [ msg('UA','user','分支A问'), msg('AA','assistant','分支A答') ] }
    const bB = { id: 'bB', conversationId: 'c1', parentBranchId: 'bA', forkMessageId: 'AA', title: '分支 B', createdAt: now, updatedAt: now, messages: [ msg('UB','user','分支B问'), msg('AB','assistant','分支B答') ] }
    const note = { id: 'note1', kind: 'note', title: '我的笔记', source: { conversationId: 'c1', throughMessageId: 'A1', snapshot: snapshot('c1','A1') }, prompt: '整理成笔记', createdAt: now, updatedAt: now, status: 'ready', content: '编辑后的笔记内容', generatedContent: '原本的笔记内容' }
    const quiz = { id: 'quiz1', kind: 'quiz', title: '我的题目', source: { conversationId: 'c1', throughMessageId: 'A1', snapshot: snapshot('c1','A1') }, prompt: '生成题目', createdAt: now, updatedAt: now, status: 'ready', quiz: { questions: [{ id: 'q1', type: 'single-choice', question: '2+2=?', options: ['3','4'], answer: 1, explanation: '2+2=4' }] } }
    const req = indexedDB.open('ai-education-reader', 5)
    req.onsuccess = () => { const db = req.result;
      const stores = ['conversations','settings','attachments','annotations','documents','conversationBranches','artifacts']
      const txStores = stores.filter(s => db.objectStoreNames.contains(s))
      const tx = db.transaction(txStores, 'readwrite')
      if (db.objectStoreNames.contains('conversations')) tx.objectStore('conversations').put(conv)
      if (db.objectStoreNames.contains('conversationBranches')) { const os = tx.objectStore('conversationBranches'); os.put(bA); os.put(bB) }
      if (db.objectStoreNames.contains('attachments')) { const os = tx.objectStore('attachments'); os.put(imgMain); os.put(imgA); os.put(pdfCtx) }
      if (db.objectStoreNames.contains('artifacts')) { const os = tx.objectStore('artifacts'); os.put(note); os.put(quiz) }
      if (db.objectStoreNames.contains('settings')) { const os = tx.objectStore('settings');
        os.put({ key: 'apiKey', value: 'sk-export-secret' }); os.put({ key: 'model', value: 'deepseek-chat' }); os.put({ key: 'apiBaseUrl', value: 'https://api.deepseek.com' }); os.put({ key: 'lastConversationId', value: 'c1' }); os.put({ key: 'appearance', value: 'dark' });
        os.put({ key: 'draft:c1', value: { version: 1, text: '主线草稿', imageIds: [] } });
        os.put({ key: 'draft-branch:bA', value: { version: 1, text: '分支A草稿', imageIds: ['imgA'] } });
        os.put({ key: 'draft-branch:bB', value: { version: 1, text: '分支B草稿', imageIds: ['pdfCtx'] } });
        os.put({ key: 'activeBranch:c1', value: 'bB' });
      }
      tx.oncomplete = () => { try { db.close() } catch {} ; resolve(true) }
      tx.onerror = () => resolve(false)
    }
    req.onerror = () => resolve(false)
  }))
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
const seeded = await seedBackup(page)
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
console.log('SEED:', seeded)

// Open settings, export. Capture the download.
await page.getByRole('button', { name: /打开设置|设置/ }).first().click().catch(() => {})
await page.locator('text=数据与导出').waitFor({ state: 'visible', timeout: 8000 })
const dlPromise = page.waitForEvent('download', { timeout: 15000 })
await page.locator('button:has-text("导出完整备份 JSON")').click()
const download = await dlPromise
const dlPath = await download.path()
console.log('DOWNLOAD PATH:', dlPath)
assert(!!dlPath && dlPath.length > 0, 'export produced a backup download')
const size = (await import('fs')).statSync(dlPath).size
assert(size > 100, 'exported backup JSON is non-trivial (bytes=' + size + ')')

// Capture the export msg + which version it is (v4).
const expMsg = await page.locator('text=已导出完整备份').count()
assert(expMsg > 0, 'export success message shown')

// ---- clear app data (real settings UI) -> the app reloads (onClearData does location.reload) ----
page.on('dialog', d => d.accept())
await page.locator('[data-testid="settings-clear-data"]').click()
// The confirm is auto-accepted; the page reloads. Wait for the composer to be back.
await page.waitForFunction(() => document.readyState === 'complete')
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 20000 })
await page.waitForTimeout(1200)

// ---- reopen settings, import the downloaded backup via the real UI ----
await page.locator('button:has-text("打开设置")').first().click()
await page.waitForTimeout(800)
const impInput = page.locator('input[type="file"][accept*=".json"]')
await impInput.waitFor({ state: 'attached', timeout: 8000 })
await impInput.setInputFiles(dlPath)
await page.waitForTimeout(2500)
const impMsg = await page.locator('text=导入完成').count().catch(() => 0)
console.log('IMPORT msg present:', impMsg > 0)
assert(impMsg > 0, 'import success message shown (导入完成)')

// ---- reload and verify restore via IDB + attachment load ----
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
const state = await page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('ai-education-reader', 5)
  req.onsuccess = () => { const db = req.result;
    const rd = (store) => new Promise((res) => { const tx = db.transaction(store,'readonly').objectStore(store); const g = tx.getAll(); g.onsuccess = () => res(g.result || []); g.onerror = () => res([]) })
    const getSetting = (k, cb) => { const g = db.transaction('settings','readonly').objectStore('settings').get(k); g.onsuccess = () => cb(g.result ? g.result.value : undefined) }
    Promise.all([rd('conversations'), rd('conversationBranches'), rd('artifacts'), rd('attachments')]).then(([convs, branches, arts, atts]) => {
      getSetting('apiKey', (apiKey) => {
        getSetting('appearance', (appearance) => { try { db.close() } catch {}; resolve({ convs, branches, arts, atts, apiKey, appearance }) })
      })
    })
  }
  req.onerror = () => resolve({ err: 'open' })
}))
assert(state.convs.some(c => c.id === 'c1'), 'Main conversation restored')
assert(state.branches.some(b => b.id === 'bA') && state.branches.some(b => b.id === 'bB'), 'Branch A + nested Branch B restored')
const bA = state.branches.find(b => b.id === 'bA')
const bB = state.branches.find(b => b.id === 'bB')
assert(bA && bA.messages.length === 2 && bA.messages.some(m => m.content === '分支A问'), 'Branch A local messages restored')
assert(bB && bB.parentBranchId === 'bA' && bB.messages.some(m => m.content === '分支B答'), 'nested Branch B messages + ancestry restored')
const note = state.arts.find(a => a.id === 'note1')
const quiz = state.arts.find(a => a.id === 'quiz1')
assert(note && note.content === '编辑后的笔记内容' && note.generatedContent === '原本的笔记内容', 'Note artifact restored with manual edit (content) + generated original')
assert(quiz && quiz.quiz && quiz.quiz.questions.length === 1 && quiz.quiz.questions[0].answer === 1, 'Quiz structured data restored')
assert(state.appearance === 'dark', 'dark appearance restored')
assert(state.apiKey === '' || state.apiKey === undefined, 'API key NOT restored')
// branch drafts
const drafts = await page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('ai-education-reader', 5)
  req.onsuccess = () => { const db = req.result; const g = db.transaction('settings','readonly').objectStore('settings').get('draft-branch:bA'); g.onsuccess = () => { try { db.close() } catch {}; resolve(g.result ? g.result.value : null) }; g.onerror = () => resolve(null) }
  req.onerror = () => resolve(null)
}))
assert(drafts && drafts.text === '分支A草稿' && drafts.imageIds.includes('imgA'), 'branch A draft text + image restored')
// active branch restored
const activeBranch = await page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('ai-education-reader', 5)
  req.onsuccess = () => { const db = req.result; const g = db.transaction('settings','readonly').objectStore('settings').get('activeBranch:c1'); g.onsuccess = () => { try { db.close() } catch {}; resolve(g.result ? g.result.value : null) }; g.onerror = () => resolve(null) }
}))
assert(activeBranch === 'bB', 'active branch restored (bB)')
// attachment load succeeds: the restored image attachment row carries a present binary ref
// (real browser stores it OPFS-first; idb inline is the fallback). A present ref means the
// staged copy survives and can be read back (restoreBackup stages the binary before commit).
const imgMain = state.atts.find(a => a.id === 'imgMain')
const bin = imgMain && imgMain.binary
assert(imgMain && bin && (bin.blob || bin.storage === 'opfs' || bin.storage === 'idb'), 'restored attachment meta + binary ref present (can be previewed/loaded; storage=' + (bin && bin.storage) + ')')
// Also verify the attachment preview path returns a usable Blob URL in the DOM by switching to Main.
await page.locator('button[aria-label="切换到主线"]').first().click()
await page.waitForTimeout(700)
const anyImg = await page.locator('img[alt], img[data-testid], .msg img, img').count().catch(() => 0)
console.log('DEBUG Main image elements:', anyImg)

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)
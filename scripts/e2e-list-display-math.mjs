import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'

const source=String.raw`**题目：**

2. 设
\[
I=\int_0^1\ln(1+x)\,dx,\qquad
J=\int_0^1\frac{\sin^2x}{1+x}\,dx,\qquad
K=\int_0^1\ln(1+\tan x)\,dx，
\]
则（　）。

(A) \(I<J<K\)  
(B) \(J<I<K\)  
(C) \(I<K<J\)  
(D) \(K<I<J\)

3. 设
\[
M=\int_{-\frac{\pi}{2}}^{\frac{\pi}{2}}\frac{\sin x}{1+x^2}\cos^4x\,dx,
\]
\[
N=\int_{-\frac{\pi}{2}}^{\frac{\pi}{2}}\left(\sin^3x+\cos^4x\right)dx,
\]
\[
P=\int_{-\frac{\pi}{2}}^{\frac{\pi}{2}}\left(x^2\sin^3x-\cos^4x\right)dx，
\]
则有（　）。

(A) \(N<P<M\)  
(B) \(M<P<N\)  
(C) \(N<M<P\)  
(D) \(P<M<N\)`
const browser=await launchBrowser()
try {
  const context=await browser.newContext({viewport:{width:1280,height:850}}),page=await context.newPage()
  await seedAndBoot(page,{convs:[{id:'lazy-math',title:'Lazy list math',createdAt:1,updatedAt:1,messages:[msg('math-user','user',source),msg('math-assistant','assistant',source)]}],settings:{lastConversationId:'lazy-math'}})
  for(const id of ['math-user','math-assistant']) {
    const root=page.locator('[data-message-id="'+id+'"]').first()
    assert.equal(await root.locator('[data-math-kind="block"]').count(),4)
    assert.equal(await root.locator('.katex-error').count(),0)
    assert.deepEqual(await root.locator('ol').evaluateAll(lists=>lists.map(list=>list.start)),[2,3],'question numbering keeps original 2 and 3')
    assert.equal(await root.locator('ol > li').count(),2,'list items are direct children, without counter-resetting wrappers')
    assert.ok((await root.textContent()).includes('则有'))
    const copied=await root.locator('[data-math-kind="block"]').first().evaluate(el=>{
      const range=document.createRange();range.selectNodeContents(el)
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range)
      const data=new DataTransfer();el.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}))
      selection.removeAllRanges();return data.getData('text/plain')
    })
    assert.ok(copied.startsWith('\\[')&&copied.endsWith('\\]')&&copied.includes('K=\\int'))
  }
  const formula=page.locator('[data-message-id="math-assistant"] [data-math-kind="block"]').first()
  await formula.scrollIntoViewIfNeeded();await formula.locator('.katex-html').click()
  await page.getByRole('button',{name:'标记公式',exact:true}).waitFor({state:'visible'})
  console.log('PASS list display math: screenshot formulas render in user/assistant messages, source copy and block-formula marking remain available')
  await context.close()
} finally {await browser.close()}

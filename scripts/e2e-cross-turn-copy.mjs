import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'

const sources = [
  '# First\n\nbegin **bold** tail',
  String.raw`A question with \(x^2\).`,
  '| Topic | Formula |\n|---|---|\n| Integral | \\(\\int|f|\\) |\n\n```js\nconst answer = 42\n```',
  'Another **question**',
  String.raw`$$\frac{1}{1+x^2}$$` + '\n\nLast **ending** finish',
]
const browser = await launchBrowser()
try {
  for (const [language,width] of [['zh-CN',1280],['en',390]]) {
    const context = await browser.newContext({viewport:{width:1280,height:850}})
    const page = await context.newPage(), errors=[]
    page.on('pageerror',error=>errors.push(error.message))
    await seedAndBoot(page,{convs:[{id:'cross-copy',title:'Cross turn copy',createdAt:1,updatedAt:1,messages:sources.map((text,i)=>msg('copy-'+i,i%2?'user':'assistant',text))}],settings:{uiLanguage:language,lastConversationId:'cross-copy'}})
    await page.setViewportSize({width,height:850})
    await page.locator('[data-message-id="copy-4"] .katex').first().waitFor()
    const copy = async (partial=false,backward=false) => page.evaluate(({partial,backward})=>{
      const roots=Array.from(document.querySelectorAll('[data-markdown-source-root]')).filter(el=>/^copy-\d$/.test(el.closest('[data-message-id]')?.dataset.messageId))
      const first=roots[0],last=roots[roots.length-1]
      const range=document.createRange()
      if(partial){
        const start=Array.from(first.querySelectorAll('[data-source-copy-leaf="text"]')).find(el=>el.textContent==='begin ').firstChild
        const end=Array.from(last.querySelectorAll('[data-source-copy-leaf="text"]')).find(el=>el.textContent===' finish').firstChild
        range.setStart(start,2);range.setEnd(end,4)
      }else{range.setStart(first,0);range.setEnd(last,last.childNodes.length)}
      const selection=getSelection();selection.removeAllRanges()
      if(backward)selection.setBaseAndExtent(range.endContainer,range.endOffset,range.startContainer,range.startOffset)
      else selection.addRange(range)
      const data=new DataTransfer()
      const event=new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true})
      range.startContainer.parentElement.dispatchEvent(event)
      selection.removeAllRanges()
      return {plain:data.getData('text/plain'),markdown:data.getData('text/markdown'),handled:event.defaultPrevented}
    },{partial,backward})
    for(const backward of [false,true]) {
      const result=await copy(false,backward)
      assert.equal(result.handled,true)
      assert.equal(result.plain,sources.join('\n\n'),'cross-turn full selection preserves exact source in DOM order, without UI labels')
      assert.equal(result.markdown,result.plain)
      const partial=await copy(true,backward)
      const expected=[sources[0].slice(sources[0].indexOf('begin ')+2),...sources.slice(1,-1),sources.at(-1).slice(0,sources.at(-1).lastIndexOf(' finish')+4)].join('\n\n')
      assert.equal(partial.plain,expected,'boundary messages are sliced, middle messages retain complete Markdown/LaTeX')
      assert.equal(partial.markdown,expected)
    }
    const all=await page.locator('[data-markdown-copy-scope]').evaluate(el=>{
      const range=document.createRange();range.selectNodeContents(el)
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range)
      const data=new DataTransfer();el.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}))
      selection.removeAllRanges();return data.getData('text/plain')
    })
    assert.equal(all,sources.join('\n\n'),'selecting the entire conversation container also copies only source messages')
    const untouched=await page.locator('textarea').first().evaluate(el=>{
      el.value='composer **draft**';el.focus();el.select()
      const event=new ClipboardEvent('copy',{clipboardData:new DataTransfer(),bubbles:true,cancelable:true})
      el.dispatchEvent(event);return !event.defaultPrevented
    })
    assert.equal(untouched,true,'composer copying remains native')
    assert.deepEqual(errors,[])
    console.log('PASS cross-turn copy '+language+'/'+width+'px: full/partial, forward/backward, user/assistant, math/table/code source and native composer copy')
    await context.close()
  }
} finally {await browser.close()}

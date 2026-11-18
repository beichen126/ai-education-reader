import assert from 'node:assert/strict'
import {launchBrowser} from './e2e-browser.mjs'
import {seedAndBoot} from './e2e-fixture.mjs'
const browser=await launchBrowser()
try{
 const page=await browser.newPage({viewport:{width:1100,height:850}}),requests=[]
 await page.addInitScript(()=>{
  window.__youtubeCalls=0;
  window.addEventListener('message',e=>{if(e.source!==window||e.data?.channel!=='reader-youtube-request')return;const m=e.data;
   if(m.type==='ping')window.postMessage({channel:'reader-youtube-response',id:m.id,available:true},location.origin);
   if(m.type==='extract'){window.__youtubeCalls++;window.postMessage({channel:'reader-youtube-response',id:m.id,data:{videoId:m.videoId,title:'字幕课程',language:'en',fetchedAt:Date.now(),segments:[{start:61,duration:5,text:'The mitochondrion produces energy.'}]}},location.origin)}
  });
 });
 await page.route('**/chat/completions',async route=>{requests.push(route.request().postDataJSON());await route.fulfill({json:{choices:[{message:{content:'已收到字幕'},finish_reason:'stop'}]}})})
 await seedAndBoot(page,{convs:[{id:'yt-test',title:'YT test',createdAt:1,updatedAt:1,messages:[]}],settings:{apiKey:'test',model:'text-only',modelVision:'text',lastConversationId:'yt-test'}})
 await page.locator('[data-testid="composer-attach"]').click()
 const menu=page.locator('[data-testid="composer-add-file-menu"]');const local=await page.locator('[data-testid="composer-add-local"]').boundingBox(),yt=await page.locator('[data-testid="composer-youtube"]').boundingBox(),ds=await page.locator('[data-testid="composer-deepseek-files"]').boundingBox();assert.ok(yt.y>local.y&&Math.abs(ds.y-yt.y)<2)
 await menu.screenshot({path:'tmp/material-menu-2x2.png'})
 await page.locator('[data-testid="composer-youtube"]').click()
 const dialog=page.getByRole('dialog',{name:'YouTube 视频解析'});
 await dialog.getByText('第一次用？查看扩展安装步骤',{exact:true}).click();await dialog.getByRole('button',{name:'复制 Chrome 地址'}).waitFor();assert.ok((await dialog.getByRole('link',{name:'下载字幕扩展 ZIP'}).getAttribute('href')).endsWith('/releases/latest/download/AI-Education-Reader-YouTube-Bridge.zip'));await dialog.getByText('第一次用？查看扩展安装步骤',{exact:true}).click();
 await dialog.getByLabel('视频链接').fill('https://youtu.be/dQw4w9WgXcQ');await dialog.getByRole('button',{name:'提取字幕',exact:true}).click();await dialog.getByText('字幕课程',{exact:true}).waitFor();await dialog.screenshot({path:'tmp/youtube-picker.png'});await dialog.getByRole('button',{name:'加入本次提问',exact:true}).click()
 assert.equal(await page.getByRole('textbox',{name:'输入消息',exact:true}).inputValue(),'')
 const openGallery=async()=>{
  await page.locator('[data-testid="sidebar-entry-images"]:visible, [data-testid="rail-images"]:visible').first().click()
  await page.getByTestId('gallery-thumbnail').first().click()
  const viewer=page.getByRole('dialog',{name:'图片大图查看',exact:true})
  await viewer.getByRole('button',{name:'查看转写稿',exact:true}).click()
  const transcript=page.getByRole('dialog',{name:'YouTube 转写稿',exact:true})
  assert.equal(await transcript.getByLabel('带时间戳的字幕').inputValue(),'[00:01:01] The mitochondrion produces energy.')
  await transcript.screenshot({path:'tmp/youtube-gallery-transcript.png'})
  await page.keyboard.press('Escape')
  await transcript.waitFor({state:'hidden'})
  await viewer.getByRole('button',{name:'关闭',exact:true}).click()
 }
 await openGallery()
 await page.getByRole('textbox',{name:'输入消息',exact:true}).fill('解释视频');await page.locator('[data-testid="composer-send-stop"]').click();await page.getByText('已收到字幕',{exact:true}).first().waitFor();assert.ok(JSON.stringify(requests[0]).includes('The mitochondrion'));assert.ok(!JSON.stringify(requests[0]).includes('image_url'))
 await page.reload({waitUntil:'networkidle'})
 await openGallery()
 await page.locator('[data-testid="composer-attach"]').click();await page.locator('[data-testid="composer-youtube"]').click();await dialog.getByLabel('视频链接').fill('https://youtu.be/dQw4w9WgXcQ');await dialog.getByRole('button',{name:'提取字幕',exact:true}).click();await dialog.getByText('已读取本地缓存，无需重复提取。',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__youtubeCalls),0)
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.locator('[data-testid="composer-attach"]').click();await menu.screenshot({path:'tmp/material-menu-mobile.png'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
 await page.evaluate(()=>{window.AndroidYoutube={extract(id){window.__nativeRequest=id},cancelRequest(id){window.__cancelledNative=id}}})
 await page.locator('[data-testid="composer-youtube"]').click()
 await dialog.getByLabel('视频链接').fill('https://youtu.be/abcdefghijk')
 await dialog.getByRole('button',{name:'提取字幕',exact:true}).click()
 await page.waitForFunction(()=>!!window.__nativeRequest)
 await dialog.getByRole('button',{name:'取消',exact:true}).click()
 await dialog.getByText('已取消',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>window.__nativeRequest===window.__cancelledNative),true)
 await page.evaluate(()=>{window.AndroidYoutube.extract=(id)=>window.postMessage({channel:'reader-youtube-response',id,error:'YouTube 页面加载失败',code:'PAGE_NETWORK_-2',stage:'loading',elapsedMs:2300},location.origin)})
 await dialog.getByRole('button',{name:'提取字幕',exact:true}).click()
 await dialog.getByText(/PAGE_NETWORK_-2/).waitFor()
 await dialog.getByRole('button',{name:'复制错误',exact:true}).waitFor()
 assert.equal(await dialog.getByRole('button',{name:'加入本次提问',exact:true}).isDisabled(),true)
 console.log('PASS material 2x2 menu, YouTube bridge preview, text-only context, unchanged composer, reload cache and mobile layout')
}finally{await browser.close()}

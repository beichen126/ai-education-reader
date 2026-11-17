import assert from 'node:assert/strict'
import {launchBrowser} from './e2e-browser.mjs'
import {seedAndBoot,msg} from './e2e-fixture.mjs'
const browser=await launchBrowser()
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}}),requests=[],errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('https://api.firecrawl.dev/v2/search',async route=>{
  const body=route.request().postDataJSON();requests.push(body)
  assert.equal(body.limit,1);assert.deepEqual(body.sources,['images'])
  await route.fulfill({json:{success:true,data:{images:[{imageUrl:'https://image.example/figure.svg',url:'https://source.example/lesson',title:'图示'}]},creditsUsed:2}})
 })
 await page.route('https://image.example/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="320"><rect width="600" height="320" fill="#b8d6fa"/><text x="80" y="160" font-size="32">Learning diagram</text></svg>'}))
 const fence=(lang,spec)=>'```'+lang+'\n'+JSON.stringify(spec)+'\n```'
 const answer=fence('genui',{title:'简洁入口',items:[{type:'card',title:'无需 schema',items:[{type:'text',content:'结构正常'},{type:'image',query:'neuron diagram'}]}]})+'\n'+fence('web-image',{type:'image',query:'neuron diagram'})+'\n'+fence('web-image',{type:'image-group',items:[{query:'animal cell'},{query:'plant cell'}]})
 await seedAndBoot(page,{convs:[{id:'images',title:'图片测试',createdAt:1,updatedAt:1,messages:[msg('answer','assistant',answer)]}],settings:{lastConversationId:'images',appearance:'dark'}})
 await page.getByText('结构正常',{exact:true}).waitFor()
 assert.equal(requests.length,0)
 await page.getByRole('button',{name:'设置',exact:true}).click()
 const panel=page.getByTestId('firecrawl-settings')
 await panel.getByLabel('Firecrawl API Key').fill('fc-test')
 await panel.getByRole('button',{name:'保存配图配置'}).click()
 await panel.getByText('已保存，单图与双图配图能力已开启').waitFor()
 await page.keyboard.press('Escape')
 await page.waitForFunction(()=>document.querySelectorAll('.reader-web-image img').length===4 && [...document.querySelectorAll('.reader-web-image img')].every(i=>i.naturalWidth>0)).catch(async e=>{console.log({requests,errors,body:(await page.locator('body').innerText()).slice(-5000)});throw e})
 assert.equal(requests.length,3)
 assert.equal(await page.locator('[data-reader-card] .reader-web-image img').count(),1)
 await page.screenshot({path:'tmp/web-images-card.png'})
 await page.reload({waitUntil:'networkidle'})
 await page.waitForFunction(()=>document.querySelectorAll('.reader-web-image img').length===4)
 assert.equal(requests.length,3,'reload reuses selected references')
 await page.setViewportSize({width:390,height:844})
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
 assert.equal(await page.locator('.reader-web-images-pair').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),1)
 await page.screenshot({path:'tmp/web-images-mobile.png'})
 await page.setViewportSize({width:1280,height:900})
 await page.getByRole('button',{name:'设置',exact:true}).click()
 await panel.getByRole('button',{name:'清除',exact:true}).click()
 await panel.getByText('已清除，模型配图能力已关闭').waitFor()
 await page.keyboard.press('Escape')
 assert.equal(await page.locator('.reader-web-images').count(),0)
 assert.deepEqual(errors,[])
 console.log('PASS schema-free GenUI, key save/clear, single/dual images, persistent reuse and mobile layout')
}finally{await browser.close()}

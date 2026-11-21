import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {launchBrowser} from './e2e-browser.mjs'
import {seedAndBoot,msg} from './e2e-fixture.mjs'
const source=readFileSync('src/genui/catalog-prompt.ts','utf8')
const prompt=JSON.parse(source.slice(source.indexOf(' = ')+3).trim())
const fences=[...prompt.matchAll(/```genui\n([\s\S]*?)\n```/g)].map(match=>match[0])
const card = (title, label, tone, content, accent) => ({
  type:'card', title, accent, items:[{type:'badge',label,tone},{type:'text',content}],
})
const bareGrid = (title, cols, items) => JSON.stringify({title,items:[{type:'grid',cols,items}]})
const filesystem = bareGrid('文件系统核心组件分工', 2, [
  card('超级块 (Superblock)','全盘总指挥','accent','记录文件系统全局元数据。','#3b82f6'),
  card('目录项 (Dentry)','名字便签与路标','success','将文件名关联到 Inode。','#10b981'),
  card('索引节点 (Inode)','文件属性档案卡','warning','记录元数据和数据位置。','#f59e0b'),
  card('页缓存 (Page Cache)','内存加速站','info','在内存中缓冲读写。','#8b5cf6'),
])
const storage = bareGrid('对象存储分级存储模型', 3, [
  card('标准存储 (Standard)','高频访问','success','• 特点：低延迟\n• 适用：经常读取的数据'),
  card('低频存储 (Infrequent)','偶尔查阅','info','• 特点：较低存储费\n• 适用：偶尔读取的数据'),
  card('归档存储 (Archive)','合规防灾','accent','• 特点：按需取回\n• 适用：长期留存的数据'),
])
const ordinaryData = JSON.stringify({title:'数据记录',items:[{id:1,name:'保留为 JSON'}]})
const browser=await launchBrowser()
try {
 for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width:1280,height:900}})
  await seedAndBoot(page,{convs:[{id:'prompt-examples',title:'提示词示例验收',createdAt:1,updatedAt:1,messages:[
    msg('answer','assistant',fences.join('\n\n')),
    msg('bare-filesystem','assistant',filesystem),
    msg('bare-storage','assistant','下面是存储分级。\n\n'+storage+'\n\n可按访问频率选择。'),
    msg('json-data','assistant',ordinaryData),
    msg('json-example','assistant','```json\n'+storage+'\n```'),
  ]}],settings:{lastConversationId:'prompt-examples'}})
  await page.setViewportSize({width,height:900})
  await page.locator('.reader-genui-surface').nth(6).waitFor()
  assert.equal(await page.locator('[data-message-id="answer"]').first().locator('.reader-genui-surface').count(),7)
  await page.getByText('analytics',{exact:true}).waitFor()
  const japaneseCard = page.getByTestId('genui-word-card').filter({ hasText:'図書館（としょかん）' })
  await japaneseCard.getByText('図書館（としょかん）',{exact:true}).waitFor()
  await japaneseCard.getByText('としょかん',{exact:true}).waitFor()
  assert.equal(await page.locator('.reader-genui-repair').count(),0,'examples render without repair')
  const radius=page.locator('input[type="range"]').first()
  await radius.fill('3')
  await page.waitForFunction(()=>document.querySelectorAll('.reader-genui-surface')[1]?.innerText.includes('28.27'))
  const quiz=page.locator('[data-genui-choices]').first()
  await quiz.getByRole('checkbox',{name:'2',exact:true}).check()
  await quiz.getByRole('checkbox',{name:'4',exact:true}).check()
  await quiz.getByRole('button',{name:'检查答案'}).click()
  assert.match(await quiz.getByRole('status').innerText(),/回答正确/)
  const fsMessage = page.locator('[data-message-id="bare-filesystem"]').first()
  const storageMessage = page.locator('[data-message-id="bare-storage"]').first()
  await fsMessage.getByText('页缓存 (Page Cache)',{exact:true}).waitFor()
  await storageMessage.getByText('低频存储 (Infrequent)',{exact:true}).waitFor()
  assert.equal(await fsMessage.locator('[data-reader-card]').count(),4)
  assert.equal(await storageMessage.locator('[data-reader-card]').count(),3)
  await storageMessage.getByText('可按访问频率选择。',{exact:true}).waitFor()
  assert.equal(await page.locator('[data-message-id="json-data"]').first().locator('.reader-genui-surface').count(),0)
  assert.equal(await page.locator('[data-message-id="json-example"]').first().locator('pre code').textContent(),storage)
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'responsive layout '+width)
  await page.close()
 }
 console.log('PASS prompt examples and bare card grids render on desktop/mobile, while normal and fenced JSON stay as text')
}finally{await browser.close()}

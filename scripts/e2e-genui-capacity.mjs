import assert from 'node:assert/strict'
import {launchBrowser} from './e2e-browser.mjs'
import {seedAndBoot,msg} from './e2e-fixture.mjs'
const browser=await launchBrowser()
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 const fence=spec=>'```genui\n'+JSON.stringify(spec)+'\n```'
 const large={title:'长内容',items:[
  {type:'accordion',items:Array.from({length:80},(_,i)=>({title:'折叠条目 '+i,items:[{type:'text',content:'折叠正文 '+i}]}))},
  {type:'steps',steps:Array.from({length:80},(_,i)=>({title:'步骤 '+i,desc:'详情'}))},
  {type:'choices',title:'较多选项',mode:'multi',items:Array.from({length:30},(_,i)=>({label:'选项 '+i}))},
  ...Array.from({length:220},(_,i)=>({type:'text',content:'文本节点 '+i})),
  {type:'text',content:'长文开头'+ '内容'.repeat(1500)+'长文结尾'},
 ]}
 const broken={items:[{type:'grid',cols:'2',items:[{type:'card',flat:'true',title:'保住卡片',items:{type:'text',content:123}},{type:'stat',label:'数字字符串',value:'85'}]},{type:'nonsense',content:'坏节点'},{type:'card',title:'后面的好节点',items:[{type:'text',content:'其余内容保留'}]},{type:'choices',title:'兼容选项',options:['甲','乙'],submit:'确认'}]}
 await seedAndBoot(page,{convs:[{id:'capacity',title:'Capacity',createdAt:1,updatedAt:1,messages:[msg('capacity','assistant',fence(large)+'\n'+fence(broken))]}],settings:{lastConversationId:'capacity'}})
 await page.getByRole('button',{name:'折叠条目 79',exact:true}).click()
 await page.getByText('折叠正文 79',{exact:true}).waitFor()
 await page.getByText('步骤 79',{exact:true}).waitFor()
 await page.getByRole('checkbox',{name:'选项 29',exact:true}).check()
 await page.getByText('文本节点 219',{exact:true}).waitFor()
 await page.getByText(/长文结尾/).first().waitFor()
 await page.getByText('保住卡片',{exact:true}).waitFor()
 await page.getByText('85',{exact:true}).waitFor()
 await page.getByText('其余内容保留',{exact:true}).waitFor()
 await page.getByRole('radio',{name:'甲',exact:true}).check()
 assert.deepEqual(errors,[])
 console.log('PASS 80 accordions, 80 steps, 30 options, 220+ nodes, long text and isolated malformed fields')
}finally{await browser.close()}

import React from 'react'
import { createRoot } from 'react-dom/client'
import { MarkdownBlocks } from '../src/markdown/MarkdownBlocks'
import { GenUiActions } from '../src/genui/GenUiBlock'
const items = [
 {type:'quiz',question:'2+2?',options:[{label:'4',correct:true},{label:'5'}],explanation:'两个二等于四'},
 {type:'table',columns:['名称','数量'],rows:[['甲',10],['乙',2]]},
 {type:'input',id:'topic',label:'学习主题',value:'数学'},
 {type:'submit',label:'继续学习',action:'continue'},
 {type:'tabs',tabs:[{label:'概念',items:[{type:'text',content:'概念内容'}]},{label:'例子',items:[{type:'text',content:'例子内容'}]}]}
]
createRoot(document.getElementById('root')!).render(<GenUiActions.Provider value={async text=>{(window as any).__action=text}}><MarkdownBlocks messageId="demo" annotations={[]} content={'```dsh-ui\n'+JSON.stringify({items})+'\n```'} /></GenUiActions.Provider>)

import {createContext,useContext,useId,useState} from 'react'
import {ChoicesNode as OriginalChoices} from 'reader-genui-choices-original'
import {GenuiActionContext} from 'reader-genui-embed'
import './choices.css'

export const ChoiceLifetime=createContext<string|undefined>(undefined)
export function ChoicesNode(props:any){
 const lifetime=useContext(ChoiceLifetime)
 if(props.node.group)return <OriginalChoices {...props}/>
 return <Choice key={(lifetime||'draft')+JSON.stringify(props.node)} {...props} lifetime={lifetime}/>
}
function Choice({node,onAction,lifetime}:any){
 const contextAction=useContext(GenuiActionContext),name=useId()
 const dispatch=onAction||contextAction
 const items=node.items, multi=node.mode==='multi',max=multi?Math.min(node.max||items.length,items.length):1
 const storageKey=lifetime?'dsh.genui.choices:'+lifetime+':'+node.action:undefined
 const [selected,setSelected]=useState<string[]>(()=>{try{const stored=JSON.parse(localStorage.getItem(storageKey||'')||'[]');return Array.isArray(stored)?stored.filter(v=>items.some((i:any)=>i.label===v&&!i.disabled)).slice(0,max):[]}catch{return []}})
 const [checked,setChecked]=useState(false)
 const [sent,setSent]=useState(false)
 const [sending,setSending]=useState(false)
 const [error,setError]=useState('')
 let answer:string[]=[]
 if(typeof node.answer==='number')answer=items[node.answer]?[items[node.answer].label]:[]
 else if(typeof node.answer==='string'){
   try{answer=node.answer.startsWith('__reader_multi__:')?JSON.parse(node.answer.slice(17)):[node.answer]}catch{answer=[]}
 }
 const graded=answer.length>0,correct=selected.length===answer.length&&answer.every(v=>selected.includes(v))
 function choose(label:string){
  let next=multi?(selected.includes(label)?selected.filter(v=>v!==label):selected.length<max?[...selected,label]:selected):[label]
  setSelected(next);setChecked(graded&&!multi);setSent(false)
  if(storageKey)try{localStorage.setItem(storageKey,JSON.stringify(next))}catch{}
 }
 async function submit(){
  if(!dispatch||!selected.length)return
  const topic=node.prompt||node.title||'这组选项'
  setSending(true);setError('')
  try{await dispatch('reader-choice-submit',{text:`关于“${topic}”，我选择了：${selected.join('、')}。`});setSent(true)}catch{setError('提交失败，请重试。')}finally{setSending(false)}
 }
 return <section className="reader-choices" data-genui-choices data-choice-mode={multi?'multi':'single'} aria-labelledby={name}>
  <h3 id={name}>{node.title||'请选择'}</h3>{node.prompt&&<p>{node.prompt}</p>}
  <p className="reader-choice-hint">{multi?`可多选，最多 ${max} 项`:'单选，各选项互斥'}</p>
  <div role={multi?'group':'radiogroup'} aria-labelledby={name}>
   {items.map((item:any)=><label key={item.label} className={'reader-choice-option'+(selected.includes(item.label)?' selected':'')}>
    <input type={multi?'checkbox':'radio'} name={name} checked={selected.includes(item.label)} disabled={sending||item.disabled||multi&&!selected.includes(item.label)&&selected.length>=max} onChange={()=>choose(item.label)}/>
    <span>{item.label}{(item.hint||item.reason)&&<small>{item.disabled?item.reason:item.hint}</small>}</span>
   </label>)}
  </div>
  <div className="reader-choice-actions">
   {graded&&multi&&<button disabled={!selected.length} onClick={()=>setChecked(true)}>检查答案</button>}
   {node.submit&&<button disabled={!selected.length||!dispatch||sent||sending} onClick={()=>void submit()}>{sending?'正在提交…':node.submit}</button>}
  </div>
  <div role="status" aria-live="polite">{checked&&<p>{correct?'回答正确':'再想一想'}{node.explanation&&'：'+node.explanation}</p>}{sent&&<p>选择已交给当前会话处理。</p>}{error&&<p>{error}</p>}</div>
 </section>
}

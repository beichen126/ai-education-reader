import {genuiTemplates} from 'reader-genui-templates'
import {useContext,useEffect,useMemo,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {GenuiBlock,GenuiActionContext,ErrorBoundary,processGenuiSpec,isRenderableProcess,setGenuiAssetBase,createGenuiArtifact,downloadGenuiArtifactJson,downloadGenuiArtifactHtml} from 'reader-genui-embed'
import {parsePartialGenuiSpec} from 'reader-genui-partial'
import {setLocale} from 'reader-genui-locale'
import {GenUiActions} from './LegacyGenUiBlock'
import {useSettings} from '../engine/settings-store'
import './advanced.css'
setGenuiAssetBase(import.meta.env.BASE_URL+'genui-assets/0.16.0/')
export default function AdvancedGenUi({source,stateKey}:{source:string;stateKey?:string}) {
 const canvasRef=useRef<HTMLDivElement>(null)
 const send=useContext(GenUiActions),language=useSettings(s=>s.uiLanguage)
 const busy=useRef(false),[status,setStatus]=useState(''),[expanded,setExpanded]=useState(false),[template,setTemplate]=useState(''),[showTemplates,setShowTemplates]=useState(false)
 const snapshot=useRef<any>(undefined)
 const text=(zh:string,en:string)=>language==='en'?en:zh
 const templates=useMemo(()=>genuiTemplates(),[language]),selected=templates.find(t=>t.id===template)
 useEffect(()=>{setLocale(language==='en'?'en':'zh')},[language])
 const result=useMemo(()=>{
  if(source.length>256000)return {error:'界面超过 256 KB 限制'}
  try {
   let complete=true,raw:any
   try {raw=JSON.parse(source)}catch{complete=false;raw=parsePartialGenuiSpec(source)}
   if(!raw)return {error:'界面正在生成…'}
   delete raw.schema
   const processed=processGenuiSpec(raw)
   if(!isRenderableProcess(processed))return {error:processed.errors.slice(0,4).join('；')}
   return {spec:processed.spec,complete}
  }catch(e){return {error:e instanceof Error?e.message:'界面格式无效'}}
 },[source])
 const dispatch=send?(action:string,payload:Record<string,unknown>)=>{
  if(busy.current)return
  busy.current=true;setStatus(language==='en'?'Sending…':'正在发送…')
  void send('[genui-action]\n'+JSON.stringify({...payload,action})).then(()=>setStatus(language==='en'?'Sent':'已发送')).catch(e=>setStatus(e instanceof Error?e.message:'发送失败')).finally(()=>{busy.current=false})
 }:undefined
 useEffect(()=>{if(!expanded)return;const previous=document.activeElement as HTMLElement|null;canvasRef.current?.querySelector<HTMLButtonElement>('button')?.focus();const close=(e:KeyboardEvent)=>{if(e.key==='Escape')setExpanded(false)};document.addEventListener('keydown',close);return()=>{document.removeEventListener('keydown',close);previous?.focus()}},[expanded])
 async function download(html:boolean){
  if(!result.spec)return
  try {const artifact=createGenuiArtifact(result.spec,snapshot.current,{locale:language==='en'?'en':'zh'});if(html){setStatus('正在导出…');await downloadGenuiArtifactHtml(artifact)}else downloadGenuiArtifactJson(artifact);setStatus('导出完成')}catch(e){setStatus(e instanceof Error?e.message:'导出失败')}
 }
 let hash=2166136261;for(let i=0;i<source.length;i++)hash=Math.imul(hash^source.charCodeAt(i),16777619)
 const durableKey=result.complete&&stateKey?'reader:'+stateKey+':'+(hash>>>0):undefined
 const ui=<div className="reader-genui-surface" data-annotatable="false" aria-label="GenUI">
  <div className="reader-genui-tools"><button type="button" onClick={()=>setExpanded(!expanded)}>{expanded?text('收起画布','Close canvas'):text('展开画布','Expand canvas')}</button><button type="button" onClick={()=>setShowTemplates(!showTemplates)}>{text('模板','Templates')}</button><button type="button" disabled={!result.complete} onClick={()=>void download(false)}>{text('导出 JSON','Export JSON')}</button><button type="button" disabled={!result.complete} onClick={()=>void download(true)}>{text('导出 HTML','Export HTML')}</button></div>
  {showTemplates&&<section className="reader-genui-templates"><label>{text('模板预览','Template preview')}<select aria-label={text('GenUI 模板','GenUI template')} value={template} onChange={e=>setTemplate(e.target.value)}><option value="">{text('选择模板','Choose a template')}</option>{templates.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>{selected&&<><p>{selected.description}</p><GenuiBlock key={selected.id} spec={selected.demo} animateEntrance={false}/><button type="button" disabled={!send||busy.current} onClick={()=>{if(send)void send(selected.instruction).catch(e=>setStatus(String(e)))}}>{text('使用此模板提问','Ask with this template')}</button></>}</section>}
  <GenuiActionContext.Provider value={dispatch}><ErrorBoundary>{result.spec?<GenuiBlock spec={result.spec} stateKey={durableKey} initialState={snapshot.current} onStateSnapshot={state=>{snapshot.current=state}} animateEntrance={false}/>:<p role="status">{result.error}</p>}</ErrorBoundary></GenuiActionContext.Provider>
  {status&&<p role="status">{status}</p>}
  <details><summary>{language==='en'?'UI source':'查看 UI 源码'}</summary><pre>{source}</pre></details>
 </div>
 return expanded?createPortal(<div ref={canvasRef} className="reader-genui-canvas" onKeyDown={e=>{if(e.key!=='Tab')return;const list=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]')).filter(el=>el.getClientRects().length);const first=list[0],last=list.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}} role="dialog" aria-modal="true" aria-label="GenUI 画布">{ui}</div>,document.body):ui
}

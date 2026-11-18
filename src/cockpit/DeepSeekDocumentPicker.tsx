import {Modal} from '../dsh/primitives/Modal'
import {Button} from '../dsh/primitives/Button'
import css from './material-picker.module.css'
import {useEffect,useRef,useState} from 'react'
import {DOCUMENT_ACCEPT,uploadDeepSeekDocument,type DeepSeekDocument} from '../api/deepseek-documents'
import {getSettingsSnapshot,useSettings} from '../engine/settings-store'
import {getSetting,setSetting} from '../storage/storage'
import {tx} from '../engine/locale'
export function DeepSeekDocumentPicker({onSelect,onClose,pendingFiles}:{onSelect:(docs:DeepSeekDocument[])=>void;onClose:()=>void;pendingFiles:File[]}){
 const [docs,setDocs]=useState<DeepSeekDocument[]>([]),[selected,setSelected]=useState<string[]>([]),[rich,setRich]=useState(true),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[ready,setReady]=useState(false)
 const [droppedFiles,setDroppedFiles]=useState(pendingFiles)
 const abort=useRef<AbortController|null>(null),alive=useRef(true)
 const apiKey=useSettings(s=>s.apiKey)
 const storageKey=useRef(''),fileInput=useRef<HTMLInputElement>(null)
 useEffect(()=>{
  let disposed=false;setReady(false);alive.current=true;storageKey.current='';setDocs([]);setSelected([]);setBusy(false)
  void (async()=>{
   const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(apiKey))
   const libraryKey='deepseek-documents:'+Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('')
   const saved=await getSetting(libraryKey)
   if(disposed)return
   storageKey.current=libraryKey;setReady(true)
   setDocs(Array.isArray(saved)?saved.filter(d=>d && typeof d.id==='string' && /^file-api-[\w-]+$/.test(d.id) && typeof d.name==='string' && Number.isFinite(d.expiresAt) && d.expiresAt>Date.now()):[])
  })().catch(()=>{if(!disposed)setNotice(tx('无法读取文件库，请重新打开。','Unable to load files. Please reopen.'))})
  return()=>{disposed=true;alive.current=false;abort.current?.abort()}
 },[apiKey])

 async function upload(files:File[]){
  if(busy||!storageKey.current)return
  const libraryKey=storageKey.current
  setBusy(true);const settings=getSettingsSnapshot(),controller=new AbortController();abort.current=controller
  const accumulated=[...docs];let next=0,done=0;const errors:string[]=[]
  await Promise.all(Array.from({length:Math.min(3,files.length)},async()=>{while(next<files.length&&!controller.signal.aborted){const file=files[next++];try{const doc=await uploadDeepSeekDocument(file,{baseUrl:settings.apiBaseUrl,apiKey:settings.apiKey,rich,signal:controller.signal});accumulated.push(doc)}catch(e){if(!controller.signal.aborted)errors.push(file.name+': '+(e instanceof Error?e.message:'失败'))}done++;if(alive.current && storageKey.current===libraryKey)setNotice(done+'/'+files.length)}}))
  try{await setSetting(libraryKey,accumulated)}catch{errors.push(tx('无法保存文件列表','Unable to save file list'))}
  if(alive.current && storageKey.current===libraryKey){setDocs(accumulated);setBusy(false);setNotice(errors.length?errors.join('\n'):tx('上传完成；选择文件后加入本次对话。','Uploads complete. Select files to attach.'))}
 }
 return <Modal open onClose={onClose} title={tx('DeepSeek 文件解析','DeepSeek file parsing')} closeLabel={tx('关闭','Close')} className={css.dialog} footer={<Button variant="primary" disabled={busy||!selected.length} onClick={()=>{onSelect(docs.filter(d=>selected.includes(d.id)));onClose()}}>{tx('加入本次提问','Attach to question')} ({selected.length}/20)</Button>}>
 <div className={css.body}>
 <p className={css.hint}>{tx('整份文件上传到 DeepSeek，解析可能计费；保存 30 天。一次上下文最多 20 份、文本合计 8 MiB。','Whole files are uploaded to DeepSeek; parsing may be billed. Stored for 30 days. Up to 20 documents and 8 MiB parsed text per context.')}</p>
 <div className={css.upload}><Button variant="outline" disabled={busy||!ready} onClick={()=>fileInput.current?.click()}>{tx('选择文件','Choose files')}</Button><small className={css.hint}>{tx('支持多文件批量上传','Upload multiple files at once')}</small><input ref={fileInput} hidden aria-label={tx('批量上传文件','Upload multiple files')} type="file" multiple accept={DOCUMENT_ACCEPT} disabled={busy||!ready} onChange={e=>{const files=Array.from(e.target.files||[]);e.target.value='';void upload(files)}}/></div>
 <label className={css.check}><input type="checkbox" checked={rich} disabled={busy} onChange={e=>setRich(e.target.checked)}/>{tx('保留图表和插图','Include charts and figures')}</label>
 {droppedFiles.length>0 && <div className={css.upload}>
  <small className={css.hint}>{tx('已拖入 '+droppedFiles.length+' 份文档','Dropped '+droppedFiles.length+' document(s)')}</small>
  <Button variant="primary" disabled={busy||!ready||!apiKey} onClick={()=>{void upload(droppedFiles);setDroppedFiles([])}}>{tx('上传拖入的文档','Upload dropped documents')}</Button>
 </div>}
 {busy&&<Button onClick={()=>abort.current?.abort()}>{tx('取消上传','Cancel uploads')}</Button>}
 {notice&&<p role="status" className={css.hint}>{notice}</p>}
 <div className={css.files}>{docs.map(d=><label key={d.id} className={css.check}><input type="checkbox" checked={selected.includes(d.id)} disabled={busy||(!selected.includes(d.id)&&selected.length>=20)} onChange={e=>setSelected(e.target.checked?[...selected,d.id]:selected.filter(id=>id!==d.id))}/>{d.name}</label>)}</div>
 </div></Modal>
}

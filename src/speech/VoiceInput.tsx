import { useEffect, useRef, useState } from 'react'
import { transcribeAudio } from './transcribe'
import { getDraft, setDraftText } from '../engine/draft-store'
export function VoiceInput({draftKey,disabled}:{draftKey:string;disabled:boolean}) {
  const [status,setStatus]=useState(''),[error,setError]=useState('')
  const recorder=useRef<MediaRecorder|null>(null),controller=useRef<AbortController|null>(null),epoch=useRef(0),timer=useRef<ReturnType<typeof setTimeout>>()
  const file=useRef<HTMLInputElement>(null)
  function cancel(){epoch.current++;clearTimeout(timer.current);controller.current?.abort();const r=recorder.current;if(r){r.onstop=null;if(r.state!=='inactive')r.stop();r.stream.getTracks().forEach(t=>t.stop())}recorder.current=null;setStatus('')}
  useEffect(()=>()=>cancel(),[draftKey])
  async function recognize(blob:Blob,token:number){
    setStatus('识别中…');controller.current=new AbortController()
    const timeout=setTimeout(()=>controller.current?.abort(),120000)
    try{const text=await transcribeAudio(blob,controller.current.signal);if(epoch.current!==token)return;const existing=getDraft(draftKey).text;setDraftText(draftKey,existing+(existing?'\n':'')+text)}catch(e){if(epoch.current===token)setError(e instanceof Error?e.message:'识别失败')}finally{clearTimeout(timeout);if(epoch.current===token)setStatus('')}
  }
  async function record(){
    if(recorder.current?.state==='recording'){recorder.current.stop();return}
    const token=++epoch.current;setError('');setStatus('请求麦克风…')
    try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});if(epoch.current!==token){stream.getTracks().forEach(t=>t.stop());return}
      let r:MediaRecorder;try{r=new MediaRecorder(stream)}catch(e){stream.getTracks().forEach(t=>t.stop());throw e}
      recorder.current=r;const chunks:Blob[]=[]
      r.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)}
      r.onstop=()=>{clearTimeout(timer.current);stream.getTracks().forEach(t=>t.stop());recorder.current=null;if(epoch.current===token)void recognize(new Blob(chunks,{type:r.mimeType}),token)}
      r.onerror=()=>{cancel();setError('录音失败，请检查麦克风。')}
      r.start();setStatus('录音中');timer.current=setTimeout(()=>{if(r.state==='recording')r.stop()},110000)
    }catch(e){if(epoch.current===token){setStatus('');setError(e instanceof Error?e.message:'无法使用麦克风')}}
  }
  return <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center',fontSize:12}}>
    <button type="button" disabled={disabled || (!!status && status!=='录音中')} onClick={()=>void record()}>{status==='录音中'?'结束并转文字':'语音转文字'}</button>
    <button type="button" disabled={disabled || !!status} onClick={()=>file.current?.click()}>导入音频</button>
    <input ref={file} type="file" accept="audio/*" hidden onChange={e=>{const selected=e.target.files?.[0];e.target.value='';if(selected){setError('');void recognize(selected,++epoch.current)}}} />
    {status&&<><span role="status">{status}</span><button type="button" onClick={cancel}>取消</button></>}
    {error&&<span role="alert">{error}</span>}
  </div>
}

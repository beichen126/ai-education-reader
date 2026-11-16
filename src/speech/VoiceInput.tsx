import css from './voice-input.module.css'
import { tx } from '../engine/locale'
import { useEffect, useRef, useState } from 'react'
import { transcribeAudio } from './transcribe'
import { getDraft, setDraftText } from '../engine/draft-store'
export function VoiceInput({draftKey,disabled}:{draftKey:string;disabled:boolean}) {
  const [status,setStatus]=useState(''),[error,setError]=useState('')
  const recorder=useRef<MediaRecorder|null>(null),controller=useRef<AbortController|null>(null),epoch=useRef(0),timer=useRef<ReturnType<typeof setTimeout>>()
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
  const recording=status==='录音中'
  const label=recording?tx('结束录音并转文字','Stop and transcribe'):status?tx('取消语音识别','Cancel voice input'):tx('语音输入','Voice input')
  return <div className={css.root}>
    <button className={css.button} type="button" data-testid="composer-microphone" disabled={disabled && !status} aria-label={label} title={label} aria-pressed={recording} aria-busy={!!status && !recording} onClick={()=>{if(status&&!recording)cancel();else void record()}}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {recording?<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>:status?<><path d="M5 12a7 7 0 0 1 12-5"/><path d="m9 9 6 6m0-6-6 6"/></>:<><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-3 0h6"/></>}
      </svg>
    </button>
    {(status||error)&&<div className={css.notice} role={error?'alert':'status'}>{error|| (recording?tx('正在录音，点击停止后识别','Recording — click to transcribe'):tx('处理中，点击取消','Processing — click to cancel'))}{error&&<button type="button" aria-label={tx('关闭提示','Dismiss')} onClick={()=>setError('')}>×</button>}</div>}
  </div>
}

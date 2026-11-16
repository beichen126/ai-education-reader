import {useEffect,useRef,useState} from 'react'
import {Modal} from '../dsh/primitives/Modal'
import {Button} from '../dsh/primitives/Button'
import {fetchTranscript} from './bridge-client'
import {youtubeVideoId,timestamp,type YoutubeTranscript} from './transcript'
import css from '../cockpit/material-picker.module.css'
export function YoutubePicker({onClose,onSelect}:{onClose:()=>void;onSelect:(t:YoutubeTranscript)=>Promise<void>}){
 const [url,setUrl]=useState(''),[language,setLanguage]=useState('auto'),[data,setData]=useState<YoutubeTranscript>(),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');const controller=useRef<AbortController|null>(null),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort()}},[]);
 async function extract(){setNotice('');setData(undefined);setBusy(true);const c=new AbortController();controller.current=c;try{const r=await fetchTranscript(youtubeVideoId(url),language,c.signal);if(alive.current){setData(r.data);setNotice(r.cached?'已读取本地缓存，无需重复提取。':'字幕提取完成。')}}catch(e){if(alive.current)setNotice(e instanceof Error?e.message:'提取失败')}finally{if(alive.current)setBusy(false)}}
 async function attach(){if(!data)return;setBusy(true);try{await onSelect(data);onClose()}catch(e){setNotice(e instanceof Error?e.message:'加入失败');setBusy(false)}}
 return <Modal open onClose={()=>{controller.current?.abort();onClose()}} title="YouTube 视频解析" closeLabel="关闭" className={css.dialog} footer={<Button variant="primary" disabled={!data||busy} onClick={()=>void attach()}>加入本次提问</Button>}>
 <div className={css.body}><p className={css.hint}>提取可用字幕，保留时间戳并作为文字附件加入。优先匹配所选语言，必要时使用 YouTube 当前转写语言；已提取的视频使用本地缓存。</p>
 <label className={css.field}>视频链接<input value={url} disabled={busy} placeholder="https://www.youtube.com/watch?v=…" onChange={e=>{setUrl(e.target.value);setData(undefined)}}/></label>
 <div className={css.actions}><label className={css.field}>字幕语言<select value={language} disabled={busy} onChange={e=>{setLanguage(e.target.value);setData(undefined)}}><option value="auto">自动选择字幕</option><option value="zh">中文优先</option><option value="en">英语优先</option><option value="ja">日语优先</option><option value="ko">韩语优先</option><option value="es">西班牙语优先</option></select></label><Button variant="outline" disabled={busy||!url.trim()} onClick={()=>void extract()}>{busy?'正在处理…':'提取字幕'}</Button>{busy&&<Button onClick={()=>controller.current?.abort()}>取消</Button>}</div>
 {!(window as any).AndroidYoutube&&<details className={css.help}><summary>首次使用：安装字幕桥接扩展</summary><p>下载并解压扩展，在 Chrome / Edge 扩展管理页开启开发者模式，选择「加载已解压的扩展程序」，然后刷新阅读器。</p><a href="https://github.com/beichen126/ai-education-reader/releases/latest" target="_blank" rel="noreferrer">下载配套扩展</a><p>提取时会打开 YouTube 视频页。若出现验证，请在该页面完成；字幕成功读取后自动返回。不需要字幕服务器。</p></details>}
 {notice&&<p role="status" className={css.hint}>{notice}</p>}
 {data&&<section className={css.preview}><strong>{data.title}</strong><small>字幕：{data.language==='default'?'YouTube 当前语言':data.language} · {data.segments.length} 段</small><div>{data.segments.map((s,i)=><p key={i}><a href={'https://www.youtube.com/watch?v='+data.videoId+'&t='+Math.floor(s.start)} target="_blank" rel="noreferrer">{timestamp(s.start)}</a> {s.text}</p>)}</div></section>}
 </div></Modal>
}

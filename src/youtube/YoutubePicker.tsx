import {writeClipboard} from '../dsh/primitives/clipboard'
import {useEffect,useRef,useState} from 'react'
import {Modal} from '../dsh/primitives/Modal'
import {Button} from '../dsh/primitives/Button'
import {fetchTranscript} from './bridge-client'
import {youtubeVideoId,timestamp,type YoutubeTranscript} from './transcript'
import css from '../cockpit/material-picker.module.css'
export function YoutubePicker({onClose,onSelect}:{onClose:()=>void;onSelect:(t:YoutubeTranscript)=>Promise<void>}){
 const [url,setUrl]=useState(''),[language,setLanguage]=useState('auto'),[data,setData]=useState<YoutubeTranscript>(),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');const controller=useRef<AbortController|null>(null),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort()}},[]);
 async function extract(){controller.current?.abort();setNotice('');setData(undefined);setBusy(true);const c=new AbortController();controller.current=c;try{const r=await fetchTranscript(youtubeVideoId(url),language,c.signal);if(alive.current&&controller.current===c&&!c.signal.aborted){setData(r.data);setNotice(r.cached?'已读取本地缓存，无需重复提取。':'字幕提取完成。')}}catch(e){if(alive.current&&controller.current===c)setNotice(e instanceof Error?e.message:'提取失败')}finally{if(alive.current&&controller.current===c)setBusy(false)}}
 async function attach(){if(!data)return;setBusy(true);try{await onSelect(data);onClose()}catch(e){setNotice(e instanceof Error?e.message:'加入失败');setBusy(false)}}
 return <Modal open onClose={()=>{controller.current?.abort();onClose()}} title="YouTube 视频解析" closeLabel="关闭" className={css.dialog} footer={<Button variant="primary" disabled={!data||busy} onClick={()=>void attach()}>加入本次提问</Button>}>
 <div className={css.body}><p className={css.hint}>提取可用字幕，保留时间戳并作为文字附件加入。优先匹配所选语言，必要时使用 YouTube 当前转写语言；已提取的视频使用本地缓存。</p>
 <label className={css.field}>视频链接<input value={url} disabled={busy} placeholder="https://www.youtube.com/watch?v=…" onChange={e=>{setUrl(e.target.value);setData(undefined)}}/></label>
 <div className={css.actions}><label className={css.field}>字幕语言<select value={language} disabled={busy} onChange={e=>{setLanguage(e.target.value);setData(undefined)}}><option value="auto">自动选择字幕</option><option value="zh">中文优先</option><option value="en">英语优先</option><option value="ja">日语优先</option><option value="ko">韩语优先</option><option value="es">西班牙语优先</option></select></label><Button variant="outline" disabled={busy||!url.trim()} onClick={()=>void extract()}>{busy?'正在处理…':'提取字幕'}</Button>{busy&&<Button onClick={()=>controller.current?.abort()}>取消</Button>}</div>
 {!(window as any).AndroidYoutube&&<details className={css.help}><summary>第一次用？查看扩展安装步骤</summary>
 <p>网页需要安装一次字幕扩展；Android APK 已内置，不用安装。这里的“加载已解压的扩展程序”是浏览器里的按钮。</p>
 <ol>
 <li><a href="https://github.com/beichen126/ai-education-reader/releases/latest/download/AI-Education-Reader-YouTube-Bridge.zip" target="_blank" rel="noreferrer">下载字幕扩展 ZIP</a>。在电脑的“下载”文件夹找到它，右键选择“全部解压缩”。</li>
 <li>打开一个新浏览器标签页，把对应地址粘贴到顶部地址栏并按回车（不是搜索框）。<div className={css.installAddress}><code>chrome://extensions</code><Button size="sm" onClick={()=>void writeClipboard('chrome://extensions').then(ok=>setNotice(ok?'Chrome 扩展页地址已复制，请粘贴到浏览器地址栏。':'复制失败，请手动复制上方地址。'))}>复制 Chrome 地址</Button></div><div className={css.installAddress}><code>edge://extensions</code><Button size="sm" onClick={()=>void writeClipboard('edge://extensions').then(ok=>setNotice(ok?'Edge 扩展页地址已复制，请粘贴到浏览器地址栏。':'复制失败，请手动复制上方地址。'))}>复制 Edge 地址</Button></div></li>
 <li>找到并打开“开发者模式”开关（Chrome 通常在右上角，Edge 通常在左侧）。</li>
 <li>点击出现的“加载已解压的扩展程序”按钮（Edge 可能叫“加载解压缩的扩展”）。弹出文件夹选择窗口后，选刚才解压的文件夹：打开它应该能看到 <code>manifest.json</code>。选的是文件夹，不是 ZIP，也不是单独的文件。</li>
 <li>看到“AI 学习阅读器 · YouTube 字幕桥接”扩展卡片后，回到阅读器刷新页面，再粘贴视频链接并点“提取字幕”。</li>
 </ol><p>提取时会打开 YouTube 视频页。若出现验证，请在该页面完成；成功后自动返回。普通手机浏览器不能按此方法安装，请使用 APK。</p><a href="https://github.com/beichen126/ai-education-reader/releases/latest" target="_blank" rel="noreferrer">查看最新版本下载页</a></details>}

 {notice&&<p role="status" className={css.hint}>{notice}{/\[[A-Z_0-9-]+ ·/.test(notice)&&<Button size="sm" onClick={()=>void writeClipboard(notice)}>复制错误</Button>}</p>}
 {data&&<section className={css.preview}><strong>{data.title}</strong><small>字幕：{data.language==='default'?'YouTube 当前语言':data.language} · {data.segments.length} 段</small><div>{data.segments.map((s,i)=><p key={i}><a href={'https://www.youtube.com/watch?v='+data.videoId+'&t='+Math.floor(s.start)} target="_blank" rel="noreferrer">{timestamp(s.start)}</a> {s.text}</p>)}</div></section>}
 </div></Modal>
}

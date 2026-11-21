import { useEffect } from 'react'
import { pauseReadAloud, resumeReadAloud, stopReadAloud, useReadAloud } from './read-aloud'
import { tx } from '../engine/locale'
import css from './read-aloud.module.css'

export function ReadAloudPlayer() {
  const state = useReadAloud()
  useEffect(()=>{
    const stop = () => stopReadAloud()
    window.addEventListener('pagehide',stop)
    return ()=>{window.removeEventListener('pagehide',stop);stop()}
  },[])
  if(state.status==='idle') return null
  return <aside className={css.player} data-testid="read-aloud-player" aria-label={tx('朗读控制','Read aloud controls')}>
    <div className={css.label} role="status">{state.status==='loading' ? state.offline ? tx('正在合成离线语音…','Synthesizing offline audio…') : tx('正在合成 DeepSeek 语音…','Synthesizing DeepSeek audio…') : state.status==='error' ? state.error : <>{state.offline ? state.lang : state.lang==='zh-CN'?tx('中文','Chinese'):tx('英文','English')} · {state.rate}× · {state.voice || tx('浏览器默认声音','Browser default voice')}</>}</div>
    <div className={css.actions}>
      {(state.status==='speaking'||state.status==='paused')&&<span data-testid="read-aloud-repeat">{state.loop?tx('循环 · 第 '+state.repeat+' 遍','Loop · pass '+state.repeat):tx('第 '+state.repeat+' / '+state.repeats+' 遍','Pass '+state.repeat+' / '+state.repeats)}</span>}
      {state.status==='speaking' && <button type="button" data-testid="read-aloud-pause" onClick={pauseReadAloud}>{tx('暂停','Pause')}</button>}
      {state.status==='paused' && <button type="button" data-testid="read-aloud-resume" onClick={resumeReadAloud}>{tx('继续','Resume')}</button>}
      <button type="button" data-testid="read-aloud-stop" onClick={()=>stopReadAloud()}>{tx('停止','Stop')}</button>
    </div>
    <small>{state.offline ? tx('使用手机选定的离线语音引擎。','Uses the phone’s selected offline speech engine.') : tx('朗读文字将发送到配置的 DeepSeek API 服务；再次播放优先复用本机缓存。','Text is sent to the configured DeepSeek API. Repeated playback reuses synthesized audio.')}</small>
  </aside>
}

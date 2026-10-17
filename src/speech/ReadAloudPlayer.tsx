import { useEffect } from 'react'
import { pauseReadAloud, resumeReadAloud, stopReadAloud, useReadAloud } from './read-aloud'
import { tx } from '../engine/locale'
import css from './read-aloud.module.css'

export function ReadAloudPlayer() {
  const state = useReadAloud()
  useEffect(()=>{
    // Prime asynchronous voice discovery without starting audio or uploading text.
    try { window.speechSynthesis?.getVoices() } catch {}
    const stop = () => stopReadAloud()
    window.addEventListener('pagehide',stop)
    return ()=>{window.removeEventListener('pagehide',stop);stop()}
  },[])
  if(state.status==='idle') return null
  return <aside className={css.player} data-testid="read-aloud-player" aria-label={tx('朗读控制','Read aloud controls')}>
    <div className={css.label} role="status">{state.status==='error' ? state.error==='unsupported' ? tx('此浏览器不支持朗读','This browser does not support read aloud') : tx('朗读失败，请检查语音设置或重试','Speech failed. Check voice settings or try again.') : <>{state.lang==='zh-CN'?tx('中文','Chinese'):tx('英文','English')} · {state.rate}× · {state.voice || tx('浏览器默认声音','Browser default voice')}</>}</div>
    <div className={css.actions}>
      {state.status!=='error'&&<span data-testid="read-aloud-repeat">{tx('第 '+state.repeat+' / '+state.repeats+' 遍','Pass '+state.repeat+' / '+state.repeats)}</span>}
      {state.status==='speaking' && <button type="button" data-testid="read-aloud-pause" onClick={pauseReadAloud}>{tx('暂停','Pause')}</button>}
      {state.status==='paused' && <button type="button" data-testid="read-aloud-resume" onClick={resumeReadAloud}>{tx('继续','Resume')}</button>}
      <button type="button" data-testid="read-aloud-stop" onClick={()=>stopReadAloud()}>{tx('停止','Stop')}</button>
    </div>
    <small>{tx('仅朗读所选文字；在线声音会将该文字发送给语音服务。','Only selected text is read. Online voices send that text to the speech provider.')}</small>
  </aside>
}

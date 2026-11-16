import { useEffect, useId, useMemo, useState } from 'react'
import { parseVocabulary, type VocabularyWord } from './vocabulary-schema'
import { readAloud, stopReadAloud, useReadAloud, setReadAloudRate } from '../speech/read-aloud'
import { selectedDeepSeekServiceProfile } from '../engine/deepseek-service-profile'
import { useSettings } from '../engine/settings-store'
import { tx } from '../engine/locale'
import css from './vocabulary.module.css'

export default function VocabularyBlock({ source }: { source: string }) {
  const parsed = useMemo(() => { try { return { spec: parseVocabulary(source) } } catch (e) { return { error: e instanceof SyntaxError ? tx('单词卡正在生成…', 'Generating word cards…') : String(e) } } }, [source])
  return <section className={css.list} aria-label={tx('GenUI 单词朗读卡', 'GenUI vocabulary cards')} data-annotatable="false">
    {parsed.spec?.title && <h3>{parsed.spec.title}</h3>}
    {parsed.spec?.items.map((item, index) => <WordCard key={index + ':' + item.word} item={item} />)}
    {parsed.error && <p role="status">{parsed.error}</p>}
    <details className={css.source}><summary>{tx('查看 UI 源码', 'UI source')}</summary><pre>{source}</pre></details>
  </section>
}

function WordCard({ item }: { item: VocabularyWord }) {
  const owner = 'vocabulary:' + useId(), speech = useReadAloud()
  const defaultVoice = useSettings(s => s.speechVoice || 'stella')
  const [voice, setVoice] = useState<'stella' | 'tide'>(defaultVoice), [rate, setRate] = useState(1), [notice, setNotice] = useState('')
  const active = speech.owner === owner && ['loading', 'speaking', 'paused'].includes(speech.status)
  useEffect(() => () => stopReadAloud(owner), [owner])
  function play() {
    if (active) { stopReadAloud(owner); return }
    const profile = selectedDeepSeekServiceProfile()
    if (!profile) { setNotice(tx('请先保存 DeepSeek 官方 API 配置和 Key，无需切换对话模型。', 'Save a DeepSeek official API profile first; keep your current chat model.')); return }
    setNotice('')
    readAloud(item.word, owner, { rate, repeats: 1, voice, apiKey: profile.config.apiKey })
  }
  return <article className={css.card} data-testid="genui-word-card">
    <div className={css.top}>
      <span className={css.label}>{tx('单词发音', 'Pronunciation')}</span>
      <div className={css.controls}>
        <button type="button" aria-label={tx('复制单词', 'Copy word')} onClick={() => { void navigator.clipboard.writeText(item.word).then(() => setNotice(tx('已复制', 'Copied'))).catch(() => setNotice(tx('复制失败，请手动选择单词。', 'Copy failed. Select the word manually.'))) }}>⧉</button>
        <select aria-label={tx('单词音色', 'Word voice')} value={voice} onChange={e => { stopReadAloud(owner); setVoice(e.target.value as 'stella' | 'tide') }}><option value="stella">Stella</option><option value="tide">Tide</option></select>
        <select aria-label={tx('单词朗读倍速', 'Word playback speed')} value={rate} onChange={e => { const next = Number(e.target.value); setRate(next); setReadAloudRate(owner, next) }}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map(speed => <option key={speed} value={speed}>{speed}×</option>)}</select>
        <button type="button" className={css.play} onClick={play} aria-label={active ? tx('停止单词朗读', 'Stop word audio') : tx('朗读单词 ' + item.word, 'Read word ' + item.word)}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M11 4 5 9H2v6h3l6 5V4Z" /><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></svg>
          {active ? speech.status === 'loading' ? tx('取消', 'Cancel') : tx('停止', 'Stop') : tx('播放', 'Play')}
        </button>
      </div>
    </div>
    <div className={css.word}>{item.word}</div>
    <div className={css.phonetic}>{item.phonetic}</div>
    <div className={css.meaning}>{item.meaning}</div>
    {item.example && <div className={css.example}>{item.example}</div>}
    {(notice || (speech.owner === owner && speech.status === 'error')) && <p role="status" className={css.notice}>{notice || speech.error}</p>}
  </article>
}

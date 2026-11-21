import { useEffect, useId, useMemo, useState } from 'react'
import { parseVocabulary, type VocabularyWord } from './vocabulary-schema'
import { hasAndroidVocabularySpeech, readAndroidVocabulary, readAloud, stopReadAloud, useReadAloud } from '../speech/read-aloud'
import { selectedDeepSeekServiceProfile } from '../engine/deepseek-service-profile'
import { useSettings } from '../engine/settings-store'
import { tx } from '../engine/locale'
import { GenUiSelection } from './GenUiSelection'
import css from './vocabulary.module.css'

export default function VocabularyBlock({ source }: { source: string }) {
  const [visible,setVisible]=useState(100)
  const parsed = useMemo(() => { try { return { spec: parseVocabulary(source) } } catch (e) { return { error: e instanceof SyntaxError ? tx('词条数据尚未完整。', 'The word entry is incomplete.') : String(e) } } }, [source])
  return <GenUiSelection className={css.list} source={source} label={tx('GenUI 单词朗读卡', 'GenUI vocabulary cards')}>
    {parsed.spec?.title && <h3>{parsed.spec.title}</h3>}
    {parsed.spec?.items.slice(0,visible).map((item, index) => <WordCard key={index + ':' + item.word} item={item} />)}
    {parsed.spec&&parsed.spec.items.length>visible&&<button type="button" onClick={()=>setVisible(n=>n+100)}>{tx('显示更多单词','Show more words')}（{visible}/{parsed.spec.items.length}）</button>}
    {parsed.spec?.partial && <p role="status">{tx('已显示完整词条，末尾数据尚未完整。','Showing complete entries. The last entry is incomplete.')}</p>}
    {parsed.error && <p role="status">{parsed.error}</p>}
    <details className={css.source} data-genui-selection-ignore><summary>{tx('查看 UI 源码', 'UI source')}</summary><pre>{source}</pre></details>
  </GenUiSelection>
}

function WordCard({ item }: { item: VocabularyWord }) {
  const owner = 'vocabulary:' + useId(), speech = useReadAloud()
  const voice = useSettings(s => s.speechVoice || 'stella')
  const rateKey = /\p{Script=Han}/u.test(item.word) ? 'chineseSpeechRate' : 'englishSpeechRate'
  const rate = useSettings(s => s[rateKey] ?? (rateKey === 'chineseSpeechRate' ? 1 : 0.9))
  const repeats = useSettings(s => s.speechRepeatCount ?? 3), loop = useSettings(s => s.speechLoop === true)
  const [notice, setNotice] = useState('')
  const active = speech.owner === owner && ['loading', 'speaking', 'paused'].includes(speech.status)
  useEffect(() => () => stopReadAloud(owner), [owner])
  function play() {
    if (active) { stopReadAloud(owner); return }
    setNotice('')
    if (hasAndroidVocabularySpeech()) {
      const kana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u
      const lang = item.lang ?? (kana.test(item.word + item.phonetic) ? 'ja' : /\p{Script=Hangul}/u.test(item.word) ? 'ko' : /\p{Script=Han}/u.test(item.word) ? 'zh-CN' : 'en')
      const reading = /^[\p{Script=Hiragana}\p{Script=Katakana}ー\s]+$/u.test(item.phonetic.trim()) ? item.phonetic.trim() : ''
      const word = lang.toLowerCase().split('-')[0] === 'ja'
        ? reading || item.word.replace(/[（(][\p{Script=Hiragana}\p{Script=Katakana}ー\s]+[）)]\s*$/u, '').trim()
        : item.word
      readAndroidVocabulary(word || item.word, lang, owner)
      return
    }
    const profile = selectedDeepSeekServiceProfile()
    if (!profile) { setNotice(tx('请在设置中填写 DeepSeek API Key。', 'Save a DeepSeek official API profile first; keep your current chat model.')); return }
    readAloud(item.word, owner, { rate, repeats, loop, voice, apiKey: profile.config.apiKey })
  }
  return <article className={css.card} data-testid="genui-word-card">
    <div className={css.top}>
      <div className={css.word}>{item.word}</div>
      <button type="button" className={css.play} onClick={play} aria-busy={active&&speech.status==='loading'} aria-pressed={active} title={active?tx('停止朗读','Stop reading'):tx('朗读','Read aloud')} aria-label={active ? tx('停止单词朗读', 'Stop word audio') : tx('朗读单词 ' + item.word, 'Read word ' + item.word)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M11 4 5 9H2v6h3l6 5V4Z" />{active?<path d="M16 8v8m4-8v8"/>:<path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>}</svg>
      </button>
    </div>
    <div className={css.phonetic}>{item.phonetic}</div>
    <div className={css.meaning}>{item.meaning}</div>
    {item.example && <div className={css.example}>{item.example}</div>}
    {(notice || (speech.owner === owner && speech.status === 'error')) && <p role="status" className={css.notice}>{notice || speech.error}</p>}
  </article>
}

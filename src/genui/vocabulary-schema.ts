export type VocabularyWord = { type: 'vocabulary'; word: string; phonetic: string; meaning: string; example?: string; lang?: string }
export function parseVocabulary(source: string): { partial?: boolean; title?: string; items: VocabularyWord[] } {
  if (source.length > 4*1024*1024) throw new Error('单词卡内容超过 4 MiB')
  let root
  try {
    root = JSON.parse(source)
  } catch (error) {
    // Recover only complete records in the top-level list, even when the last string is truncated.
    const list = /"(?:items|reader-vocabulary)"\s*:\s*\[/.exec(source)
    if (!list) throw error
    const items = []
    let depth = 0, quoted = false, escaped = false, start = 0
    for (let i = list.index + list[0].length; i < source.length; i++) {
      const ch = source[i]
      if (quoted) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') quoted = false
      } else if (ch === '"') quoted = true
      else if (ch === '{') { if (depth++ === 0) start = i }
      else if (ch === '}' && --depth === 0) {
        try { items.push(JSON.parse(source.slice(start, i + 1))) } catch { break }
      } else if (depth === 0 && ch === ']') break
    }
    if (!items.length) throw error
    root = {items, partial:true}
  }
  const records = root?.items ?? root?.['reader-vocabulary']
  if (!Array.isArray(records) || !records.length) throw new Error('单词卡需要 vocabulary 条目')
  const items:VocabularyWord[]=[]
  for (const item of records) {
    if (!item || (item.type != null && item.type !== 'vocabulary') || typeof item.word !== 'string' || !item.word.trim()) continue
    const lang = typeof item.lang === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i.test(item.lang) ? item.lang : undefined
    items.push({type:'vocabulary',word:item.word.slice(0,120),phonetic:typeof item.phonetic==='string'?item.phonetic.slice(0,200):'',meaning:typeof item.meaning==='string'?item.meaning.slice(0,2000):'',...(typeof item.example==='string'?{example:item.example.slice(0,2000)}:{}),...(lang?{lang}:{})})
  }
  if(!items.length)throw new Error('没有可显示的有效单词')
  return { partial:root.partial === true, title: typeof root.title === 'string' ? root.title.slice(0, 120) : undefined, items }
}

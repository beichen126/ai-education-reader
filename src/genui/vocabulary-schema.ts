export type VocabularyWord = { type: 'vocabulary'; word: string; phonetic: string; meaning: string; example?: string }
export function parseVocabulary(source: string): { title?: string; items: VocabularyWord[] } {
  if (source.length > 4*1024*1024) throw new Error('单词卡内容超过 4 MiB')
  const root = JSON.parse(source)
  if (root.schema !== 'reader-vocabulary' || !Array.isArray(root.items) || !root.items.length) throw new Error('单词卡需要 vocabulary 条目')
  const items:VocabularyWord[]=[]
  for (const item of root.items) {
    if (!item || item.type !== 'vocabulary' || typeof item.word !== 'string' || !item.word.trim()) continue
    items.push({type:'vocabulary',word:item.word.slice(0,120),phonetic:typeof item.phonetic==='string'?item.phonetic.slice(0,200):'',meaning:typeof item.meaning==='string'?item.meaning.slice(0,2000):'',...(typeof item.example==='string'?{example:item.example.slice(0,2000)}:{})})
  }
  if(!items.length)throw new Error('没有可显示的有效单词')
  return { title: typeof root.title === 'string' ? root.title.slice(0, 120) : undefined, items }
}

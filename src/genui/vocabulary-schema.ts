export type VocabularyWord = { type: 'vocabulary'; word: string; phonetic: string; meaning: string; example?: string }
export function parseVocabulary(source: string): { title?: string; items: VocabularyWord[] } {
  if (source.length > 64000) throw new Error('单词卡超过 64 KB')
  const root = JSON.parse(source)
  if (root.schema !== 'reader-vocabulary' || !Array.isArray(root.items) || !root.items.length || root.items.length > 40) throw new Error('单词卡需要 1–40 个 vocabulary 条目')
  for (const item of root.items) {
    if (!item || item.type !== 'vocabulary' || typeof item.word !== 'string' || !item.word.trim() || item.word.length > 120 || typeof item.phonetic !== 'string' || item.phonetic.length > 200 || typeof item.meaning !== 'string' || !item.meaning.trim() || item.meaning.length > 2000 || (item.example !== undefined && (typeof item.example !== 'string' || item.example.length > 2000))) throw new Error('单词卡字段无效：需要 word、phonetic、meaning，可选 example')
  }
  return { title: typeof root.title === 'string' ? root.title.slice(0, 120) : undefined, items: root.items }
}

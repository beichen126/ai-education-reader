/** Context around an exact anchored range: at most two sentences on each side,
 * plus the unmarked remainder of the selected sentence. Offsets disambiguate
 * repeated words rather than always showing the first occurrence. */
export function markContext(text: string, start: number, end: number): {before:string;exact:string;after:string} {
  const lo = Math.max(0, Math.min(text.length,start)), hi = Math.max(lo,Math.min(text.length,end))
  if(typeof Intl.Segmenter==='function') {
    const sentences=[...new Intl.Segmenter(undefined,{granularity:'sentence'}).segment(text)]
    const first=sentences.findIndex(sentence=>sentence.index+sentence.segment.length>lo)
    const last=sentences.findIndex(sentence=>sentence.index+sentence.segment.length>=hi)
    if(first>=0 && last>=0) {
      const begin=sentences[Math.max(0,first-2)].index
      const finish=sentences[Math.min(sentences.length-1,last+2)]
      return {before:text.slice(begin,lo),exact:text.slice(lo,hi),after:text.slice(hi,finish.index+finish.segment.length)}
    }
  }
  const prefix = text.slice(0,lo), suffix = text.slice(hi)
  const boundaries = [...prefix.matchAll(/[。！？.!?]+[”’"']?\s*/gu)].map(match=>match.index!+match[0].length)
  const begin = boundaries.length >= 3 ? boundaries[boundaries.length-3] : 0
  const ends = [...suffix.matchAll(/[。！？.!?]+[”’"']?\s*/gu)].map(match=>match.index!+match[0].length)
  const needed = /[。！？.!?][”’"']?\s*$/u.test(text.slice(lo,hi)) ? 2 : 3
  const finish = ends.length >= needed ? ends[needed-1] : suffix.length
  return {before:prefix.slice(begin),exact:text.slice(lo,hi),after:suffix.slice(0,finish)}
}

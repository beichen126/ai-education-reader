// Stage 9.4C: flat transcription + global structure domain tests (PURE).
import {
  parseTocJsonl, assignLocalRowIds, parseTocStructure, normalizeTocLevels,
  validateTocStructure, mapTocSourcePages,
} from '../src/documents/ai-toc.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// --- JSONL multiple lines + blank lines ---
{
  const r = parseTocJsonl('{"title":"第一章 绪论","pageLabel":"1","sourceImageIndex":1,"visualIndent":0,"numbering":"第一章"}\n\n{"title":"第一节 研究对象","pageLabel":"3","sourceImageIndex":1,"visualIndent":1,"numbering":"第一节"}\n{"title":"一、自然地理学","pageLabel":"5","sourceImageIndex":1,"visualIndent":2,"numbering":"一、"}\n')
  assert(r.ok === true, 'JSONL multiple lines parses')
  if (r.ok) { assert(r.rows.length === 3, '3 rows (got ' + r.rows.length + ')'); assert(r.rows[0].title === '第一章 绪论' && r.rows[0].visualIndent === 0 && r.rows[0].numbering === '第一章', 'row fields kept') }
}
// --- whole fenced JSONL accepted ---
{
  const r = parseTocJsonl('```jsonl\n{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":2}\n```')
  assert(r.ok === true && r.ok && r.rows.length === 2, 'whole fenced JSONL accepted')
}
// --- single malformed line diagnostic (not dropped silently) ---
{
  const r = parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\nnot-json\n{"title":"B","pageLabel":"2","sourceImageIndex":2}')
  assert(r.ok === false, 'malformed line -> whole result invalid (strict, no silent loss)')
  if (!r.ok) assert((r as { diagnostics: string[] }).diagnostics.length === 1, 'precise diagnostic for malformed line')
}
// --- all malformed -> ok:false with diagnostics ---
{
  const r = parseTocJsonl('garbage\nmore garbage')
  assert(r.ok === false && r.ok === false ? r.diagnostics.length > 0 : true, 'all-malformed -> error with diagnostics')
}
// --- titles containing Chinese punctuation ---
{
  const r = parseTocJsonl('{"title":"《自然地理学》：研究对象与分科","pageLabel":"1","sourceImageIndex":1}')
  assert(r.ok === true && r.ok && r.rows[0].title.includes('《自然地理学》'), 'Chinese punctuation preserved in title')
}
// --- roman pageLabel kept as string ---
{
  const r = parseTocJsonl('{"title":"前言","pageLabel":"iii","sourceImageIndex":1}')
  assert(r.ok === true && r.ok && r.rows[0].pageLabel === 'iii', 'roman pageLabel preserved (got ' + (r.ok ? r.rows[0].pageLabel : '') + ')')
}
// --- same physical page multiple rows ---
{
  const r = parseTocJsonl('{"title":"四、本书内容和结构","pageLabel":"19","sourceImageIndex":1}\n{"title":"五、编排","pageLabel":"19","sourceImageIndex":1}')
  assert(r.ok === true && r.ok && r.rows.length === 2 && r.rows[0].pageLabel === '19' && r.rows[1].pageLabel === '19', 'two rows same printed page accepted')
}
// --- assignLocalRowIds ---
{
  const r = parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":2}')
  const rows = assignLocalRowIds(r.ok ? r.rows : [])
  assert(rows.map(x => x.id).join(',') === 'r0001,r0002', 'stable local ids r0001/r0002 (got ' + rows.map(x => x.id).join(',') + ')')
  assert(rows.map(x => x.rowOrder).join(',') === '0,1', 'rowOrder assigned')
}
// --- compact structure parse ---
{
  const r = parseTocStructure('{"levels":[1,2]}')
  assert(r.ok === true && r.ok && r.levels.join(',') === '1,2', 'compact structure object parses')
  const fenced = parseTocStructure('```json\n{"levels":[1,2]}\n```')
  assert(fenced.ok === true, 'fenced compact structure parses')
  const old = parseTocStructure('{"id":"r0001","level":1}')
  assert(old.ok === false, 'legacy per-row id/level output rejected')
}

// --- structure validation: valid global levels ---
{
  const rows = assignLocalRowIds(parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":2}\n{"title":"B.1","pageLabel":"2","sourceImageIndex":1}').ok ? parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":2}\n{"title":"B.1","pageLabel":"2","sourceImageIndex":1}').rows : [])
  const v = validateTocStructure(rows, [1,2,3])
  assert(v.ok === true && v.levels.join(',') === '1,2,3', 'valid global levels accepted (got ' + v.levels.join(',') + ')')
}
// --- level count mismatch rejected ---
{
  const rows = assignLocalRowIds(parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":2}').ok ? parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":2}').rows : [])
  const short = validateTocStructure(rows, [1])
  assert(short.ok === false && short.diagnostics.some(d => d.code === 'LEVEL_COUNT_MISMATCH'), 'short level sequence rejected')
  const long = validateTocStructure(rows, [1,2,3])
  assert(long.ok === false && long.diagnostics.some(d => d.code === 'LEVEL_COUNT_MISMATCH'), 'long level sequence rejected')
}
// --- level jump rejected ---
{
  const rows = assignLocalRowIds(parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":2}\n{"title":"C","pageLabel":"3","sourceImageIndex":1}').ok ? parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":2}\n{"title":"C","pageLabel":"3","sourceImageIndex":1}').rows : [])
  const v = validateTocStructure(rows, [1,2,4])
  assert(v.ok === false, 'level jump 2->4 rejected')
}
// --- first row not level 1 is allowed for a mid-directory selection ---
{
  const rows = assignLocalRowIds(parseTocJsonl('{"title":"第三节","pageLabel":"1","sourceImageIndex":1}\n{"title":"第四节","pageLabel":"2","sourceImageIndex":1}\n{"title":"第二章","pageLabel":"3","sourceImageIndex":1}').ok ? parseTocJsonl('{"title":"第三节","pageLabel":"1","sourceImageIndex":1}\n{"title":"第四节","pageLabel":"2","sourceImageIndex":1}\n{"title":"第二章","pageLabel":"3","sourceImageIndex":1}').rows : [])
  const v = validateTocStructure(rows, [2,2,1])
  assert(v.ok === true && v.levels.join(',') === '2,2,1', 'mid-directory first level 2 accepted')
}
// --- normalization: min->1, relative depth kept ---
{
  assert(normalizeTocLevels([3,4,5]).join(',') === '1,2,3', 'levels 3,4,5 -> 1,2,3')
}

// --- cross-page continuity: page A tail + page B head; sourceImageIndex maps each batch ---
{
  const pageAJ = '{"title":"第二章 自然地理","pageLabel":"20","sourceImageIndex":1}\n{"title":"第一节 地形","pageLabel":"21","sourceImageIndex":2}'
  const pageBJ = '{"title":"一、地质构造","pageLabel":"22","sourceImageIndex":1}\n{"title":"二、地貌过程","pageLabel":"23","sourceImageIndex":2}\n{"title":"第二节 气候","pageLabel":"24","sourceImageIndex":3}'
  const pa = parseTocJsonl(pageAJ), pb = parseTocJsonl(pageBJ)
  const a = mapTocSourcePages(assignLocalRowIds(pa.ok ? pa.rows : []), [9,10])
  const b = mapTocSourcePages(assignLocalRowIds(pb.ok ? pb.rows : []), [11,12,13])
  const aRows = a.ok ? a.rows : [], bRows = b.ok ? b.rows : []
  const all = [...aRows, ...bRows.map((x, i) => ({ ...x, id: 'r' + String(aRows.length + i + 1).padStart(4,'0'), rowOrder: aRows.length + i }))]
  const titles = all.map(x => x.title)
  assert(titles[0].includes('第二章') && titles[titles.length-1].includes('第二节'), 'cross-page transcription keeps line order (got ' + titles.join('|') + ')')
  assert(all[0].tocPage === 9 && all[1].tocPage === 10 && all[2].tocPage === 11, 'tocPage resolved locally per batch (9,10,11...)')
  const v = validateTocStructure(all, all.map((x,i) => Math.min(i < 2 ? 1 : (i<4?2:3), 3)))
  assert(v.ok === true, 'cross-page global inference valid')
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)

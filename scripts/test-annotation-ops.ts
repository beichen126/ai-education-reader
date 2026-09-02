import { makeAnnotation, toggleWithin, normalizeAnchor, shouldToggleAll, rebuildQuote } from '../src/annotations/annotation-ops.ts'
import type { Annotation } from '../src/annotations/annotation-types.ts'
let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
const C='conv', M='msg', TXT='ABCDEFG'
const anchor = { scope:'block' as const, blockId:'p1' }
function ann(id:string, s:number, e:number): Annotation { return makeAnnotation(C, M, anchor, TXT, s, e, id) }
// 1 empty add
{ const r = toggleWithin(TXT,C,M,anchor,0,2,[]); assert(r.keep.length===1 && r.keep[0].target.start===0 && r.keep[0].target.end===2, '1 empty add') }
// 2 overlap merge
{ const a=[ann('a',0,3)], r=toggleWithin(TXT,C,M,anchor,2,5,a); assert(r.keep.length===1 && r.keep[0].target.start===0 && r.keep[0].target.end===5 && r.keep[0].id==='a', '2 overlap merge') }
// 3 adjacent merge
{ const a=[ann('a',0,3)], r=toggleWithin(TXT,C,M,anchor,3,5,a); assert(r.keep.length===1 && r.keep[0].target.start===0 && r.keep[0].target.end===5, '3 adjacent merge') }
// 4 fully covered (whole range) -> remove all
{ const a=[ann('a',0,7)], r=toggleWithin(TXT,C,M,anchor,0,7,a); assert(r.keep.length===0 && r.remove.length===1, '4 fully covered whole -> remove') }
// 5 middle split
{ const a=[ann('a',0,7)], r=toggleWithin(TXT,C,M,anchor,2,5,a); assert(r.keep.length===2 && r.keep[0].target.end===2 && r.keep[1].target.start===5, '5 middle split') }
// 5b
{ const a=[ann('a',0,7)], r=toggleWithin(TXT,C,M,anchor,2,5,a); assert(r.keep[0].id==='a' && r.keep[1].id!=='a', '5b split id') }
// 6 prefix
{ const a=[ann('a',0,7)], r=toggleWithin(TXT,C,M,anchor,0,3,a); assert(r.keep.length===1 && r.keep[0].target.start===3, '6 prefix remove') }
// 7 suffix
{ const a=[ann('a',0,7)], r=toggleWithin(TXT,C,M,anchor,4,7,a); assert(r.keep.length===1 && r.keep[0].target.end===4, '7 suffix remove') }
// 8 multi union
{ const a=[ann('a',0,2),ann('b',3,5),ann('c',6,7)], r=toggleWithin(TXT,C,M,anchor,1,6,a); assert(r.keep.length===1 && r.keep[0].target.start===0 && r.keep[0].target.end===7, '8 multi union') }
// 9 disjoint
{ const a=[ann('a',0,2)], r=toggleWithin(TXT,C,M,anchor,5,6,a); assert(r.keep.length===2, '9 disjoint preserved+new') }
// 10 untouched id stable
{ const a=[ann('a',0,2)], r=toggleWithin(TXT,C,M,anchor,5,6,a); assert(r.keep.some(x=>x.id==='a'), '10 untouched id stable') }
// 13 quote
{ const a=[ann('a',0,7)], r=toggleWithin(TXT,C,M,anchor,2,5,a); assert(r.keep[0].target.quote.exact===TXT.slice(0,2) && r.keep[1].target.quote.exact===TXT.slice(5,7), '13 quote exact') }
// normalize adjacent
{ const a=[ann('a',0,3),ann('b',3,5)], n=normalizeAnchor(a,anchor); assert(n.length===1 && n[0].target.end===5, 'normalize adjacent merge') }
// shouldToggleAll
{ const a=[ann('a',0,3)]; assert(shouldToggleAll([{anchor,start:0,end:3}],a)==='remove', 'fully covered -> remove'); assert(shouldToggleAll([{anchor,start:0,end:5}],a)==='add', 'not fully -> add') }
// merge id strategy (keep earliest/leftmost id on merge)
{ const a=[ann('a',0,2),ann('b',3,5)], r=toggleWithin(TXT,C,M,anchor,1,5,a); assert(r.keep[0].id==='a' && r.keep[0].target.start===0 && r.keep[0].target.end===5, 'merge keeps leftmost/earliest id') }
// split id strategy
{ const a=[ann('a',0,7)], r=toggleWithin(TXT,C,M,anchor,2,5,a); assert(r.keep[0].id==='a', 'split keeps original id on left') }
console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)
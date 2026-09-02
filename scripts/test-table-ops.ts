import { normalizeBounds, toggleTableCells, toggleWholeTable, hasExactRectangle, hasWholeTable, boundsCoverCell, rectangleCoversCell } from '../src/annotations/annotation-ops.ts'
import type { Annotation } from '../src/annotations/annotation-types.ts'
let pass=0, fail=0; function assert(c,m){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
const C='c', M='m', T='t1'
// rectangle normalize forward + reverse
{ const f=normalizeBounds(1,1,3,4), r=normalizeBounds(3,4,1,1); assert(f.rowStart===1&&f.rowEnd===3&&f.columnStart===1&&f.columnEnd===4, '1 forward bounds (1,1)-(3,4)'); assert(r.rowStart===1&&r.rowEnd===3&&r.columnStart===1&&r.columnEnd===4, '2 reverse bounds identical') }
// header->body (row0 included)
{ const b=normalizeBounds(0,1,2,2); assert(b.rowStart===0&&b.columnStart===1&&b.columnEnd===2, '4 header(row0)->body(2,2) bounds') }
// full row / full col
{ assert(normalizeBounds(1,0,1,3).columnStart===0&&normalizeBounds(1,0,1,3).columnEnd===3, '5 full row (cols 0-3)'); assert(normalizeBounds(0,2,3,2).rowStart===0&&normalizeBounds(0,2,3,2).rowEnd===3, '6 full col (rows 0-3)') }
// table-cells toggle
{ let r=toggleTableCells(C,M,T,normalizeBounds(1,1,3,4),[]); assert(r.keep.length===1 && r.keep[0].target.type==='table-cells', '7 empty add rectangle') }
{ const a=[ { id:'x', conversationId:C, messageId:M, target:{type:'table-cells',tableId:T,bounds:normalizeBounds(1,1,3,4)}, createdAt:0,updatedAt:0,version:1 } as Annotation ]; let r=toggleTableCells(C,M,T,normalizeBounds(3,4,1,1),a); assert(r.keep.length===0 && r.remove.length===1, '8 exact duplicate (reverse) removes') }
{ const a=[ { id:'x', conversationId:C, messageId:M, target:{type:'table-cells',tableId:T,bounds:normalizeBounds(1,1,3,4)}, createdAt:0,updatedAt:0,version:1 } as Annotation ]; let r=toggleTableCells(C,M,T,normalizeBounds(2,2,4,5),a); assert(r.keep.length===2, '9 partial overlap coexists (no 2D merge)') }
{ const a=[ { id:'x', conversationId:C, messageId:M, target:{type:'table-cells',tableId:T,bounds:normalizeBounds(1,1,3,4)}, createdAt:0,updatedAt:0,version:1 } as Annotation ]; let r=toggleTableCells(C,M,T,normalizeBounds(1,5,2,6),a); const two=r.keep.length===2; assert(two, '10 no 2D split; separate rects coexist') }
// whole table toggle
{ let r=toggleWholeTable(C,M,T,[]); assert(r.keep.length===1 && r.keep[0].target.type==='table', '12 add whole-table') }
{ let a=toggleWholeTable(C,M,T,[]).keep; let r=toggleWholeTable(C,M,T,a); assert(r.keep.length===0 && r.remove.length===1, '13 second whole-table toggle removes') }
{ let a=[ ...toggleWholeTable(C,M,T,[]).keep, ...toggleWholeTable(C,M,'t2',[]).keep ]; assert(toggleWholeTable(C,M,T,a).remove.length===1, '14 per-table: toggling T only affects T, one per table') }
// priority helpers
{ const a=[ { id:'x',conversationId:C,messageId:M,target:{type:'table-cells',tableId:T,bounds:normalizeBounds(1,1,3,4)},createdAt:0,updatedAt:0,version:1 } as Annotation ]; assert(boundsCoverCell(a[0].target.bounds,2,2), 'boundsCoverCell inside'); assert(!boundsCoverCell(a[0].target.bounds,0,0), 'boundsCoverCell outside'); assert(rectangleCoversCell(a,T,2,2)&&!hasWholeTable(a,T), '16 rectangle covers cell, no whole') }
{ const a=[ { id:'x',conversationId:C,messageId:M,target:{type:'table',tableId:T},createdAt:0,updatedAt:0,version:1 } as Annotation ]; assert(hasWholeTable(a,T) && (hasWholeTable(a,T) || rectangleCoversCell(a,T,0,0)), '17 whole-table -> cell highlighted via whole||rect (renderer precedence)') }
console.log('\nRESULT pass='+pass+' fail='+fail); process.exit(fail===0?0:1)
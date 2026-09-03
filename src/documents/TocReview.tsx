// TOC review workflow (Stage 9.4B, commit 2). Shows the AI-extracted + mapped chapter
// draft next to the PDF reader so the user can verify each item, adjust title/level/page,
// apply a global page-offset, and then save to 'ai-toc'. AI is never the authority: save
// only happens after the user explicitly confirms, and only when the draft is valid.
import { useEffect, useMemo, useState } from 'react'
import { validateChapterDraft, buildChapterTreeFromDraft, type ChapterDraftItem } from './chapter-builder'
import { applyGlobalOffset, setManualPageOverride, type MappedTocItem } from './toc-mapping'
import type { ChapterNode, DocumentChapterSource } from './document-types'
import css from './toc-review.module.css'

export type TocReviewSave = { chapters: ChapterNode[]; source: DocumentChapterSource }

type Props = {
  pageCount: number
  items: MappedTocItem[]
  labels: string[] | null
  labelsPlainNumeric: boolean
  onJump: (page: number) => void
  onSave: (save: TocReviewSave) => Promise<void>
  onClose: () => void
  onEditAll: (items: MappedTocItem[]) => void
}

type ReviewState = Record<number, 'unchecked' | 'verified' | 'issue'>

export function TocReview({ pageCount, items, labels, labelsPlainNumeric, onJump, onSave, onClose, onEditAll }: Props) {
  const [rows, setRows] = useState<MappedTocItem[]>(items)
  const [state, setState] = useState<ReviewState>(() => { const s: ReviewState = {}; items.forEach((_, i) => s[i] = 'unchecked'); return s })
  const [idx, setIdx] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [offset, setOffset] = useState<string>('0')
  const [confirmUnchecked, setConfirmUnchecked] = useState(false)

  // Rebuild rows when a new mapped draft arrives.
  useEffect(() => { setRows(items); setState(() => { const s: ReviewState = {}; items.forEach((_, i) => s[i] = 'unchecked'); return s }); setIdx(0) }, [items])

  // --- Review correctness (Stage 9.4B.1): unresolved NEVER fabricates page 1; only
  // resolved rows become a ChapterDraft; build/save is blocked while any row is
  // unresolved or the draft is invalid. ---
  const hasUnresolved = rows.some(r => r.startPage == null)
  const toDraft = (r: MappedTocItem[]): ChapterDraftItem[] => r
    .filter((it) => it.startPage != null)
    .map((it, i) => ({ id: 'ai' + i, title: it.title, level: it.level, startPage: it.startPage as number }))
  const validation = useMemo(() => {
    if (hasUnresolved) return { ok: false, issues: [{ index: 0, code: 'unresolved-page' as const, message: '存在页码待确认的条目' }] }
    return validateChapterDraft(toDraft(rows), pageCount)
  }, [rows, pageCount, hasUnresolved])

  const invalid = !validation.ok
  const unresolvedCount = rows.filter(r => r.startPage == null).length
  const invalidCount = hasUnresolved
    ? unresolvedCount + Math.max(0, validation.issues.filter(x => x.code !== 'unresolved-page').length)
    : validation.issues.length

  const jump = (i: number) => { const p = rows[i]?.startPage; if (p != null) onJump(p); setIdx(i) }
  const markVerified = (i: number) => setState(s => ({ ...s, [i]: 'verified' }))
  const markIssue = (i: number) => setState(s => ({ ...s, [i]: 'issue' }))

  // 继续检查: mark the CURRENT item verified (only when resolved + the single-row draft
  // validates), then move to the next unchecked item and jump the reader to it.
  const continueReview = () => {
    const cur = rows[idx]
    if (cur && cur.startPage != null) {
      const one = [{ id: 'x', title: cur.title, level: cur.level, startPage: cur.startPage }]
      if (validateChapterDraft(one, pageCount).ok) markVerified(idx)
    }
    const next = rows.findIndex((_, i) => state[i] === 'unchecked' && i > idx)
    const target = next >= 0 ? next : rows.findIndex((_, k) => state[k] === 'unchecked')
    if (target >= 0) jump(target)
  }

  const editRow = (i: number, patch: Partial<Pick<MappedTocItem, 'title' | 'level' | 'startPage'>>) => setRows(r => r.map((it, j) => (j === i ? { ...it, ...patch } : it)))

  const applyGlobal = () => {
    const n = Number(offset.trim())
    if (!Number.isFinite(n)) return
    setRows(r => applyGlobalOffset(r, n))
  }
  // Page input: empty -> null (unresolved); valid integer >=1 -> page override; other text
  // left as-is (validation state flags it) — never coerced to 1.
  const onPageInput = (i: number, raw: string) => {
    if (raw.trim() === '') { setRows(r => r.map((it, j) => (j === i ? { ...it, startPage: null } : it))); return }
    const n = Number(raw.trim())
    if (Number.isInteger(n) && n >= 1) setRows(r => setManualPageOverride(r, i, n))
  }

  const save = async () => {
    if (saving) return
    if (invalid || hasUnresolved) { setSaveError('还有 ' + invalidCount + ' 项需要修正后才能保存。'); return }
    const unchecked = rows.filter((_, i) => state[i] === 'unchecked').length
    if (unchecked > 0) { setConfirmUnchecked(true); return }
    await doSave()
  }
  const doSave = async () => {
    setSaving(true); setSaveError(null)
    try {
      const tree = buildChapterTreeFromDraft(toDraft(rows), pageCount, 'ai-toc')
      await onSave({ chapters: tree, source: 'ai-toc' })
    } catch { setSaveError('保存目录失败，请重试。'); setSaving(false) }
  }

  const verifiedCount = Object.values(state).filter(v => v === 'verified' || v === 'issue').length

  // Escape closes the review (never the Reader). The Reader's keydown is guarded while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); if (confirmUnchecked) setConfirmUnchecked(false); else onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmUnchecked, onClose])

  return (
    <div className={css.overlay} data-testid="toc-review">
      <div className={css.panel}>
        <div className={css.header}>
          <span className={css.title}>检查目录</span>
          <span className={css.sub} data-testid="toc-review-progress">已检查 {verifiedCount} / {rows.length}</span>
          <div className={css.headerBtns}>
            <button type="button" className={css.btn} data-testid="toc-review-edit-all" onClick={() => onEditAll(rows)}>编辑全部目录</button>
            <button type="button" className={css.btn} data-testid="toc-review-close" onClick={onClose}>取消</button>
            <button type="button" className={css.btnPrimary} data-testid="toc-review-save" disabled={saving || invalid} onClick={save}>{saving ? '保存中…' : '保存目录'}</button>
          </div>
        </div>
        {saveError && <div className={css.err} data-testid="toc-review-error">{saveError}</div>}
        {invalid && <div className={css.err} data-testid="toc-review-invalid">还有 {invalidCount} 项需要修正后才能保存。</div>}
        {unresolvedCount > 0 && <div className={css.warn} data-testid="toc-review-unresolved">有 {unresolvedCount} 项页码待确认。</div>}
        <div className={css.body}>
          <div className={css.list} data-testid="toc-review-list">
            {rows.map((it, i) => (
              <div key={i} className={css.item + (i === idx ? ' ' + css.active : '')} data-testid={'toc-review-item-' + i} data-sp={it.startPage ?? ''} data-state={state[i] || 'unchecked'} onClick={() => jump(i)}>
                <div className={css.itemTitle}><span className={css.itemMark}>{state[i] === 'verified' ? '✓' : state[i] === 'issue' ? '!' : '·'}</span><span className={css.itemText}>{it.title}</span></div>
                <div className={css.itemMeta}>L{it.level} · {it.pageLabel}{it.startPage != null ? ' → PDF ' + it.startPage : ' · 页码待确认'}</div>
                <div className={css.itemBtns}>
                  <button type="button" className={css.mini} data-testid={'toc-review-ok-' + i} onClick={(e) => { e.stopPropagation(); markVerified(i) }}>✓ 正确</button>
                  <button type="button" className={css.mini} data-testid={'toc-review-issue-' + i} onClick={(e) => { e.stopPropagation(); markIssue(i) }}>! 待改</button>
                </div>
              </div>
            ))}
            {rows.length === 0 && <div className={css.empty} data-testid="toc-review-empty">没有识别到条目。</div>}
          </div>
          <div className={css.adjust} data-testid="toc-review-adjust">
            <div className={css.adjustTitle}>快速调整当前项（{rows[idx]?.title || '—'}）</div>
            <label className={css.field}>标题 <input className={css.input} data-testid="toc-review-title" value={rows[idx]?.title || ''} onChange={e => editRow(idx, { title: e.target.value })} /></label>
            <label className={css.field}>层级 <input className={css.input} data-testid="toc-review-level" value={String(rows[idx]?.level || '')} onChange={e => editRow(idx, { level: parseInt(e.target.value, 10) || 1 })} /></label>
            <label className={css.field}>PDF页 <input className={css.input} data-testid="toc-review-page" value={rows[idx]?.startPage ?? ''} placeholder="待确认" onChange={e => onPageInput(idx, e.target.value)} /></label>
            {labelsPlainNumeric && (
              <div className={css.offset}>
                <div className={css.adjustTitle}>页码映射（offset）</div>
                <label className={css.field}>offset <input className={css.input} data-testid="toc-review-offset" value={offset} onChange={e => setOffset(e.target.value)} /></label>
                <button type="button" className={css.mini} data-testid="toc-review-apply-offset" onClick={applyGlobal}>重新计算全书映射</button>
              </div>
            )}
          </div>
          <div className={css.nav}>
            <button type="button" className={css.btn} data-testid="toc-review-prev" onClick={() => idx > 0 && jump(idx - 1)}>上一项</button>
            <button type="button" className={css.btn} data-testid="toc-review-next" onClick={continueReview}>继续检查</button>
          </div>
        </div>
        {confirmUnchecked && (
          <div className={css.confirmWrap} data-testid="toc-review-unchecked-confirm">
            <div className={css.confirmBox}>
              <div>还有 {rows.filter((_, i) => state[i] === 'unchecked').length} 项未检查，仍然保存目录？</div>
              <div className={css.confirmBtns}>
                <button type="button" className={css.btn} data-testid="toc-review-unchecked-no" onClick={() => setConfirmUnchecked(false)}>继续检查</button>
                <button type="button" className={css.btnPrimary} data-testid="toc-review-unchecked-yes" onClick={() => { setConfirmUnchecked(false); void doSave() }}>仍然保存</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

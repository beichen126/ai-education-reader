// TOC review workflow (Stage 9.4B, commit 2). Shows the AI-extracted + mapped chapter
// draft next to the PDF reader so the user can verify each item, adjust title/level/page,
// apply a global page-offset, and then save to 'ai-toc'. AI is never the authority: save
// only happens after the user explicitly confirms, and only when the draft is valid.
import { useEffect, useMemo, useRef, useState } from 'react'
import { validateChapterDraft, buildChapterTreeFromDraft, type ChapterDraftItem } from './chapter-builder'
import { applyGlobalOffset, setManualPageOverride, validateMappedTocReview, canUseNumericOffset, canonicalNumericPageNumber, type MappedTocItem } from './toc-mapping'
import { emptyReviewState, markRowUnchecked, markChangedRowsUnchecked, verifiedCount as countVerified, resolveSaveStage, type ReviewState, type ReviewStateValue } from './toc-review-state'
import type { ChapterNode, DocumentChapterSource } from './document-types'
import css from './toc-review.module.css'
import { tx } from '../engine/locale'

export type TocReviewSave = { chapters: ChapterNode[]; source: DocumentChapterSource }

type Props = {
  pageCount: number
  items: MappedTocItem[]
  notice?: string
  onJump: (page: number) => void
  onSave: (save: TocReviewSave) => Promise<void>
  onClose: () => void
  onEditAll: (items: MappedTocItem[]) => void
}

export function TocReview({ pageCount, items, notice, onJump, onSave, onClose, onEditAll }: Props) {
  const [rows, setRows] = useState<MappedTocItem[]>(items)
  const [state, setState] = useState<ReviewState>(() => emptyReviewState(items.length))
  const [idx, setIdx] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [offset, setOffset] = useState<string>('0')
  const [confirmUnchecked, setConfirmUnchecked] = useState(false)
  const [confirmIssue, setConfirmIssue] = useState(false)
  // Finding 9.4D.2-0.3: a save request walks a preflight state machine. These ack flags
  // record that the user has ALREADY confirmed a given blocker for the current save attempt,
  // so when BOTH unchecked and issue conditions exist the UI confirms each in turn.
  const uncheckedAckRef = useRef(false)
  const issueAckRef = useRef(false)
  const pageInputRef = useRef<HTMLInputElement | null>(null)
  const [levelRaw, setLevelRaw] = useState<Record<number, string>>({})

  // Rebuild rows when a new mapped draft arrives.
  useEffect(() => { setRows(items); setState(() => { const s: ReviewState = {}; items.forEach((_, i) => s[i] = 'unchecked'); return s }); setIdx(0); setLevelRaw({}) }, [items])

  // Finding 9.4D.2-0.6.24: on first open, auto-select the first resolved item and jump the
  // Reader to its physical page so the user immediately sees "left: chapter | right: PDF".
  // If the first item is unresolved, stay on the current Reader page (never guess).
  const mountJumpDoneRef = useRef(false)
  useEffect(() => {
    if (mountJumpDoneRef.current) return
    mountJumpDoneRef.current = true
    if (items.length === 0) return
    const firstResolved = items.findIndex(it => it.startPage != null)
    if (firstResolved >= 0) { const p = items[firstResolved].startPage as number; setIdx(firstResolved); onJump(p) }
  }, [items, onJump])

  // --- Review correctness (Stage 9.4C.1): single source validator (no duplicated
  // hasUnresolved/toDraft/validation). Unresolved is NEVER coerced to 1; a blocking
  // row count is distinct rows, not issue count. ---
  const toDraft = (r: MappedTocItem[]): ChapterDraftItem[] => r
    .filter((it) => it.startPage != null)
    .map((it, i) => ({ id: 'ai' + i, title: it.title, level: it.level, startPage: it.startPage as number }))
  const validation = useMemo(() => {
    const base = validateMappedTocReview(rows, pageCount)
    // Level raw input: empty / non-integer / <1 must block the row (never coerced to 1).
    const blocking = [...base.blockingRowIndices]
    const issuesByRow: Record<number, string[]> = { ...base.issuesByRow }
    let errorCount = base.errorCount
    for (const k of Object.keys(levelRaw)) {
      const i = Number(k)
      const raw = levelRaw[i]
      if (i < 0 || i >= rows.length) continue
      if (raw === undefined) continue
      if (raw.trim() === '' || !Number.isInteger(Number(raw.trim())) || Number(raw.trim()) < 1) {
        if (!blocking.includes(i)) { blocking.push(i); errorCount++ }
        issuesByRow[i] = issuesByRow[i] || []
        const invalidLevel = tx('层级非法', 'Invalid level')
        if (!issuesByRow[i].includes(invalidLevel)) issuesByRow[i].push(invalidLevel)
      }
    }
    return {
      ok: errorCount === 0,
      unresolvedCount: base.unresolvedCount,
      blockingRowIndices: blocking,
      issuesByRow,
      errorCount,
    }
  }, [rows, pageCount, levelRaw])

  const invalid = !validation.ok
  const unresolvedCount = validation.unresolvedCount
  const invalidCount = validation.errorCount
  const isBlocking = (i: number) => validation.blockingRowIndices.includes(i)
  const unresolvedNumericIndices = useMemo(() => rows.flatMap((row, i) => row.startPage == null && canonicalNumericPageNumber(row.pageLabel) != null ? [i] : []), [rows])
  const unresolvedBlankCount = useMemo(() => rows.filter(row => row.startPage == null && row.pageLabel.trim() === '').length, [rows])
  const unresolvedOtherCount = unresolvedCount - unresolvedNumericIndices.length - unresolvedBlankCount
  const nonMappingInvalidCount = validation.blockingRowIndices.filter(i => rows[i]?.startPage != null).length
  const needsSingleCalibration = unresolvedCount > 0 && unresolvedNumericIndices.length === unresolvedCount && nonMappingInvalidCount === 0

  // v1.1.3: numeric offset / anchor calibration is available whenever at least one row's
  // printed page label can be read as a safe integer. This deliberately does NOT depend on
  // the PDF providing native PageLabels — those are the AUTO-MAPPING capability; the numeric
  // offset is the separate FALLBACK CALIBRATION capability (previously hidden for PDFs with no
  // PageLabels, which is exactly when it is needed most).
  const canOffset = useMemo(() => canUseNumericOffset(rows), [rows])

  // A resolved row jumps to its destination. An unresolved/invalid mapping still
  // has trustworthy local provenance (`tocPage`), so selecting the error jumps to
  // the exact PDF outline page where the row was recognized instead of doing
  // nothing and leaving the user to hunt for it.
  const jump = (i: number) => {
    const row = rows[i]
    const target = row?.startPage ?? row?.tocPage
    if (Number.isInteger(target) && (target as number) >= 1 && (target as number) <= pageCount) onJump(target as number)
    setIdx(i)
  }

  const beginCalibration = () => {
    const target = unresolvedNumericIndices[0]
    if (target == null) return
    jump(target)
    setSaveError(null)
    window.requestAnimationFrame(() => pageInputRef.current?.focus())
  }

  const beginIssueReview = () => {
    const target = validation.blockingRowIndices[0]
    if (target == null) return
    jump(target)
    window.requestAnimationFrame(() => pageInputRef.current?.focus())
  }

  const markVerified = (i: number) => setState(s => ({ ...s, [i]: 'verified' }))
  // 9.4C.1: verify is a no-op (with a hint) for a blocking/unresolved row — never marked verified.
  const verifyButton = (i: number) => { if (isBlocking(i)) { setSaveError(tx('第 ' + (i + 1) + ' 项仍需修正后才能标记为正确。', 'Item ' + (i + 1) + ' must be corrected before it can be verified.')); return } markVerified(i) }

  // 继续检查 (Stage 9.4D.1): if the CURRENT row is blocking, set an explicit hint and STAY
  // on it (never silently jump to the next item). Otherwise mark verified and advance.
  const continueReview = () => {
    const cur = rows[idx]
    if (cur && isBlocking(idx)) {
      setSaveError(cur.startPage == null && canonicalNumericPageNumber(cur.pageLabel) != null
        ? tx('只需在右侧填写当前项的 PDF 物理页，再点击“按此对应关系匹配其余页码”。', 'Enter this item\'s physical PDF page on the right, then choose “Match remaining pages from this pair”. You do not need to correct every row.')
        : tx('第 ' + (idx + 1) + ' 项仍需修正后才能继续检查。', 'Item ' + (idx + 1) + ' must be corrected before continuing.'))
      return
    }
    if (cur) markVerified(idx)
    const next = rows.findIndex((_, i) => state[i] === 'unchecked' && i > idx)
    const target = next >= 0 ? next : rows.findIndex((_, k) => state[k] === 'unchecked')
    if (target >= 0) jump(target)
  }

  // Any title edit resets that row's review state to unchecked (finding 8).
  const editRow = (i: number, patch: Partial<Pick<MappedTocItem, 'title' | 'level' | 'startPage'>>) => { setRows(r => r.map((it, j) => (j === i ? { ...it, ...patch } : it))); setState(s => markRowUnchecked(s, i)) }

  // Global offset remap: reset EVERY row whose startPage actually changed to unchecked.
  const applyGlobal = () => {
    const n = Number(offset.trim())
    if (!Number.isFinite(n)) return
    setRows(r => {
      const before = r.map(x => x.startPage)
      const after = applyGlobalOffset(r, n)
      setState(s => markChangedRowsUnchecked(s, before, after))
      return after
    })
  }
  // v1.1.3 "以当前项校准全书": the user never computes an offset. They just fill the current
  // item's PDF physical page (the PDF页 field above) and click calibrate. The system derives
  // offset = physicalPage - printedLabel, then remaps every other canonical-Arabic item.
  // The anchor row is already a manualOverride so it is never overwritten by the global remap.
  const calibrateWithCurrent = () => {
    const cur = rows[idx]
    if (!cur) return
    if (cur.startPage == null) { setSaveError(tx('请先为当前项填写对应的 PDF 物理页，再用它校准全书。', 'Enter the physical PDF page for this item before calibrating the full document.')); return }
    const printed = canonicalNumericPageNumber(cur.pageLabel)
    if (printed == null) { setSaveError(tx('「' + cur.pageLabel + '」不是可识别的纯数字页码，无法作为校准项。', '“' + cur.pageLabel + '” is not a numeric page label and cannot be used for calibration.')); return }
    const n = cur.startPage - printed
    setOffset(String(n))
    setRows(r => {
      const before = r.map(x => x.startPage)
      const after = applyGlobalOffset(r, n)
      setState(s => markChangedRowsUnchecked(s, before, after))
      return after
    })
  }
  // Page input: empty -> null (unresolved); valid integer >=1 -> page override; other text
  // left as-is (validation state flags it) — never coerced to 1.
  const onPageInput = (i: number, raw: string) => {
    setState(s => markRowUnchecked(s, i))
    if (raw.trim() === '') { setRows(r => r.map((it, j) => (j === i ? { ...it, startPage: null } : it))); return }
    const n = Number(raw.trim())
    if (Number.isInteger(n) && n >= 1) setRows(r => setManualPageOverride(r, i, n))
  }
  // 9.4C.1 raw level input: empty/非整数 is INVALID (blocking row), never coerced to 1.
  const onLevelInput = (i: number, raw: string) => {
    setState(s => markRowUnchecked(s, i))
    setLevelRaw(prev => ({ ...prev, [i]: raw }))
    const n = Number(raw.trim())
    if (Number.isInteger(n) && n >= 1) { setRows(r => r.map((it, j) => (j === i ? { ...it, level: n } : it))) }
  }

  // Finding 9.4D.2-0.3: save preflight state machine. Top-level entry resets the ack flags,
  // then walks the machine: invalid -> block; unchecked (not yet acked) -> confirm; issue (not
  // yet acked) -> confirm; otherwise doSave. Both conditions present -> the user confirms each
  // in turn (unchecked first, then issue) before the final save runs.
  const requestSave = () => {
    if (saving) return
    if (needsSingleCalibration) {
      setSaveError(tx('无需逐条修正。请先确认一个“印刷页→PDF 物理页”的对应关系，系统会自动映射其余数字页码。', 'No row-by-row correction is needed. First confirm one printed-page → physical-PDF-page pair and the remaining numeric pages will be mapped automatically.'))
      beginCalibration()
      return
    }
    uncheckedAckRef.current = false
    issueAckRef.current = false
    advanceSave()
  }
  const advanceSave = () => {
    if (saving) return
    const stage = resolveSaveStage({
      invalid,
      invalidCount,
      uncheckedCount: rows.filter((_, i) => state[i] === 'unchecked').length,
      issueCount: rows.filter((_, i) => state[i] === 'issue').length,
      uncheckedAck: uncheckedAckRef.current,
      issueAck: issueAckRef.current,
    })
    if (stage.kind === 'invalid') { setSaveError(tx('还有 ' + stage.invalidCount + ' 项需要修正后才能保存。已定位到第一个问题所在的 PDF 页。', stage.invalidCount + ' items must be corrected before saving. The reader has jumped to the PDF page containing the first issue.')); beginIssueReview(); return }
    if (stage.kind === 'confirm-unchecked') { setConfirmUnchecked(true); return }
    if (stage.kind === 'confirm-issue') { setConfirmIssue(true); return }
    void doSave()
  }
  const doSave = async () => {
    setSaving(true); setSaveError(null)
    try {
      const tree = buildChapterTreeFromDraft(toDraft(rows), pageCount, 'ai-toc')
      await onSave({ chapters: tree, source: 'ai-toc' })
    } catch { setSaveError(tx('保存目录失败，请重试。', 'Unable to save the outline. Try again.')); setSaving(false) }
  }

  // Progress reflects TRULY verified rows only — a row marked 待修改 is NOT counted as verified.
  const verifiedCount = countVerified(state)

  // Escape closes the review (never the Reader). The Reader's keydown is guarded while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); if (confirmUnchecked) setConfirmUnchecked(false); else if (confirmIssue) setConfirmIssue(false); else onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmUnchecked, confirmIssue, onClose])

  return (
    <div className={css.overlay} data-testid="toc-review">
      <div className={css.panel}>
        <div className={css.header}>
          <span className={css.title}>{tx('检查目录', 'Review outline')}</span>
          <span className={css.sub} data-testid="toc-review-progress">{tx('已检查 ', 'Reviewed ')}{verifiedCount} / {rows.length}</span>
          <div className={css.headerBtns}>
            <button type="button" className={css.btn} data-testid="toc-review-edit-all" onClick={() => onEditAll(rows)}>{tx('编辑全部目录', 'Edit full outline')}</button>
            <button type="button" className={css.btn} data-testid="toc-review-close" onClick={onClose}>{tx('取消', 'Cancel')}</button>
            <button type="button" className={css.btnPrimary} data-testid="toc-review-save" disabled={saving || invalid} onClick={requestSave}>{saving ? tx('保存中…', 'Saving…') : tx('保存目录', 'Save outline')}</button>
          </div>
        </div>
        {notice && <div className={css.warn} data-testid="toc-review-notice">{notice}</div>}
        {saveError && <div className={css.err} data-testid="toc-review-error">{saveError}</div>}
        {nonMappingInvalidCount > 0 && (
          <div className={css.issueHelp} data-testid="toc-review-invalid">
            <span>{tx('还有 ' + nonMappingInvalidCount + ' 项内容需要修正后才能保存。', nonMappingInvalidCount + ' content items must be corrected before saving.')}</span>
            <button type="button" className={css.mini} data-testid="toc-review-locate-issue" onClick={beginIssueReview}>{tx('定位第一个问题页', 'Go to first issue page')}</button>
          </div>
        )}
        {needsSingleCalibration ? (
          <div className={css.mappingHelp} data-testid="toc-review-calibration-needed">
            <span>{tx('PDF 没有提供可靠的内置页码映射。不需要逐条修正 ' + unresolvedCount + ' 项：只需确认一个印刷页对应的 PDF 物理页，其余数字页码会自动映射。', 'This PDF has no reliable embedded page-label mapping. You do not need to correct ' + unresolvedCount + ' rows individually: confirm one printed-page → physical-PDF-page pair and the remaining numeric pages will be mapped automatically.')}</span>
            <button type="button" className={css.mini} data-testid="toc-review-start-calibration" onClick={beginCalibration}>{tx('开始一次校准', 'Calibrate once')}</button>
          </div>
        ) : unresolvedCount > 0 && (
          <div className={css.mappingHelp} data-testid="toc-review-unresolved">
            <span>{tx('有 ' + unresolvedCount + ' 项页码无法自动映射' + (unresolvedBlankCount > 0 ? '（其中 ' + unresolvedBlankCount + ' 项未识别到印刷页码）' : '') + '。', unresolvedCount + ' page mappings could not be resolved automatically' + (unresolvedBlankCount > 0 ? '; ' + unresolvedBlankCount + ' rows have no recognized printed page number' : '') + (unresolvedOtherCount > 0 ? '; ' + unresolvedOtherCount + ' use non-numeric labels' : '') + '.')}</span>
            <button type="button" className={css.mini} data-testid="toc-review-locate-unresolved" onClick={beginIssueReview}>{tx('定位第一个问题页', 'Go to first issue page')}</button>
          </div>
        )}
        <div className={css.reviewBody}>
          <div className={css.list} data-testid="toc-review-list">
            {rows.map((it, i) => (
              <div key={i} className={css.item + (i === idx ? ' ' + css.active : '')} data-testid={'toc-review-item-' + i} data-sp={it.startPage ?? ''} data-state={state[i] || 'unchecked'} onClick={() => jump(i)}>
                <div className={css.itemTitle}><span className={css.itemMark}>{state[i] === 'verified' ? '✓' : state[i] === 'issue' ? '!' : '·'}</span><span className={css.itemText}>{it.title}</span></div>
                <div className={css.itemMeta}>L{it.level} · {it.pageLabel}{it.startPage != null ? ' → PDF ' + it.startPage : tx(' · 页码待确认', ' · page needs confirmation')}</div>
                <div className={css.itemBtns}>
                  <button type="button" className={css.mini} data-testid={'toc-review-ok-' + i} disabled={isBlocking(i)} onClick={(e) => { e.stopPropagation(); verifyButton(i) }}>✓ {tx('正确', 'Correct')}</button>
                </div>
              </div>
            ))}
            {rows.length === 0 && <div className={css.empty} data-testid="toc-review-empty">{tx('没有识别到条目。', 'No entries were detected.')}</div>}
          </div>
          <div className={css.adjust} data-testid="toc-review-adjust">
            <div className={css.adjustTitle}>{tx('快速调整当前项', 'Adjust current item')}</div>
            <div className={css.adjustCurrent} data-testid="toc-review-current-title">{rows[idx]?.title || '—'}</div>
            <label className={css.field}>{tx('标题', 'Title')} <input className={css.input} data-testid="toc-review-title" value={rows[idx]?.title || ''} onChange={e => editRow(idx, { title: e.target.value })} /></label>
            <label className={css.field}>{tx('层级', 'Level')} <input className={css.input} data-testid="toc-review-level" value={levelRaw[idx] ?? String(rows[idx]?.level ?? '')} inputMode="numeric" onChange={e => onLevelInput(idx, e.target.value)} /></label>
            <label className={css.field}>{tx('PDF页', 'PDF page')} <input ref={pageInputRef} className={css.input} data-testid="toc-review-page" value={rows[idx]?.startPage ?? ''} placeholder={tx('待确认', 'Unconfirmed')} onChange={e => onPageInput(idx, e.target.value)} /></label>
            {canOffset && (
              <div className={css.offset}>
                <div className={css.adjustTitle}>{tx('页码映射', 'Page mapping')}</div>
                <div className={css.calib} data-testid="toc-review-calib">
                  <span className={css.calibMeta}>{tx('当前项印刷页 ', 'Printed page ')}<b data-testid="toc-review-calib-printed">{rows[idx]?.pageLabel ?? '—'}</b> · {tx('对应 PDF 页 ', 'PDF page ')}{rows[idx]?.startPage != null ? rows[idx]?.startPage : tx('请在上方“PDF页”填写后再匹配', 'enter a PDF page above to calibrate')}</span>
                  <button type="button" className={css.mini} data-testid="toc-review-calibrate" onClick={calibrateWithCurrent}>{tx('按此对应关系匹配其余页码', 'Match remaining pages from this pair')}</button>
                </div>
                <details className={css.detail}>
                  <summary className={css.detailSummary}>{tx('高级：数字偏移（offset）', 'Advanced: numeric offset')}</summary>
                  <div className={css.offsetAdv}>
                    <label className={css.field}>offset <input className={css.input} data-testid="toc-review-offset" value={offset} onChange={e => setOffset(e.target.value)} /></label>
                    <button type="button" className={css.mini} data-testid="toc-review-apply-offset" onClick={applyGlobal}>{tx('重新计算全书映射', 'Recalculate full-document mapping')}</button>
                  </div>
                </details>
              </div>
            )}
          </div>
        </div>
        <div className={css.nav}>
          <button type="button" className={css.btn} data-testid="toc-review-prev" onClick={() => idx > 0 && jump(idx - 1)}>{tx('上一项', 'Previous item')}</button>
          <button type="button" className={css.btn} data-testid="toc-review-next" onClick={continueReview}>{tx('继续检查', 'Continue review')}</button>
        </div>
        {confirmUnchecked && (
          <div className={css.confirmWrap} data-testid="toc-review-unchecked-confirm">
            <div className={css.confirmBox}>
              <div>{tx('还有 ' + rows.filter((_, i) => state[i] === 'unchecked').length + ' 项未检查，仍然保存目录？', rows.filter((_, i) => state[i] === 'unchecked').length + ' items are unreviewed. Save the outline anyway?')}</div>
              <div className={css.confirmBtns}>
                <button type="button" className={css.btn} data-testid="toc-review-unchecked-no" onClick={() => setConfirmUnchecked(false)}>{tx('继续检查', 'Continue review')}</button>
                <button type="button" className={css.btnPrimary} data-testid="toc-review-unchecked-yes" onClick={() => { setConfirmUnchecked(false); uncheckedAckRef.current = true; advanceSave() }}>{tx('仍然保存', 'Save anyway')}</button>
              </div>
            </div>
          </div>
        )}
        {confirmIssue && (
          <div className={css.confirmWrap} data-testid="toc-review-issue-confirm">
            <div className={css.confirmBox}>
              <div>{tx('还有 ' + rows.filter((_, i) => state[i] === 'issue').length + ' 项标记为待修改，仍然保存？', rows.filter((_, i) => state[i] === 'issue').length + ' items are marked for changes. Save anyway?')}</div>
              <div className={css.confirmBtns}>
                <button type="button" className={css.btn} data-testid="toc-review-issue-no" onClick={() => setConfirmIssue(false)}>{tx('返回修改', 'Go back')}</button>
                <button type="button" className={css.btnPrimary} data-testid="toc-review-issue-yes" onClick={() => { setConfirmIssue(false); issueAckRef.current = true; advanceSave() }}>{tx('仍然保存', 'Save anyway')}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

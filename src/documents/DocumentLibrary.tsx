// Document Library (Stage 9.2B1): lists persisted local documents, imports PDFs
// (validated, chapters from native outline when present) and opens the Reader. The list
// holds only DocumentSummary — never sourceBlob / full trees.
// Deleting a Document NEVER touches Context attachments (no cascade ownership).
// Agent B (B1/B3/B4/B6/B7/B9): user-controlled sorting, cards with a ⋯ overflow menu
// (rename/delete), conflict-aware import (name conflict + exact duplicate), and import
// logic extracted into document-import-service.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatBytes } from '../storage/diagnostics'
import { deleteDocument, renameDocument, listDocumentSummaries, getDocumentContextDescriptor, DocumentNameConflictError, type DocumentSummary } from './document-service'
import { analyzeImport, createDocumentFromImport, sanitizeFileName, nextAvailableName, type ImportAnalysis } from './document-import-service'
import { sortDocuments, loadSortPreference, saveSortPreference, DOCUMENT_SORT_KEYS, DOCUMENT_SORT_LABELS, type DocumentSortKey } from './document-sort'
import { documentUiActions, useDocumentUi } from './document-ui-store'
import { pdfErrorMessage } from '../pdf/pdf-session'
import { PdfError } from '../pdf/pdf-service'
import { getSessionsCurrent } from '../engine/sessions-store'
import { DocumentContextPicker } from './DocumentContextPicker'
import { executeDocumentContext } from './document-context-service'
import type { PdfSelection } from '../pdf/pdf-types'
import css from './document-library.module.css'
import { localizedErrorText, tx } from '../engine/locale'

type PendingImport = { analysis: ImportAnalysis; file: File }

function relTimeLabel(at: number): string {
  if (!at) return ''
  const diff = Math.max(0, Date.now() - at)
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000
  if (diff < MIN) return tx('刚刚', 'Just now')
  if (diff < HOUR) return tx(Math.floor(diff / MIN) + ' 分钟前', Math.floor(diff / MIN) + ' min ago')
  if (diff < DAY) return tx(Math.floor(diff / HOUR) + ' 小时前', Math.floor(diff / HOUR) + ' hr ago')
  if (diff < 30 * DAY) return tx(Math.floor(diff / DAY) + ' 天前', Math.floor(diff / DAY) + ' days ago')
  if (diff < 365 * DAY) return tx(Math.floor(diff / (30 * DAY)) + ' 个月前', Math.floor(diff / (30 * DAY)) + ' mo ago')
  return tx(Math.floor(diff / (365 * DAY)) + ' 年前', Math.floor(diff / (365 * DAY)) + ' yr ago')
}

export function DocumentLibrary() {
  const ui = useDocumentUi(x => x)
  const [summaries, setSummaries] = useState<DocumentSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  // ---- sorting (B1) ----
  const [sortKey, setSortKeyState] = useState<DocumentSortKey>(() => loadSortPreference())
  // ---- import conflict (B6/B7) ----
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null)
  const [customName, setCustomName] = useState<string | null>(null)
  const [customNameErr, setCustomNameErr] = useState<string | null>(null)
  // ---- rename (B4) / delete (B10) ----
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameErr, setRenameErr] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<DocumentSummary | null>(null)
  // ---- per-card overflow menu ----
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  // ---- ctx (unchanged) ----
  const [ctxDocId, setCtxDocId] = useState<string | null>(null)
  const [ctxBusy, setCtxBusy] = useState<{ done: number; total: number } | null>(null)
  const [ctxMsg, setCtxMsg] = useState<string | null>(null)
  const ctxGenRef = useRef(0)
  const ctxCancelledRef = useRef(false)
  const ctxOpRef = useRef<{ targetConversationId: string; documentId: string } | null>(null)
  const open = ui.view === 'library'

  async function addFromPicker(selection: PdfSelection) {
    if (!ctxDocId) return
    const targetConversationId = getSessionsCurrent()
    if (!targetConversationId) { setCtxMsg(tx('当前没有可加入的对话，请先创建一个会话。', 'There is no current chat. Create one first.')); setCtxDocId(null); return }
    const gen = ++ctxGenRef.current
    ctxCancelledRef.current = false
    const docId = ctxDocId
    ctxOpRef.current = { targetConversationId, documentId: docId }
    let fileName = 'document.pdf'
    try { fileName = (await getDocumentContextDescriptor(docId))?.fileName || 'document.pdf' } catch { /* fallback */ }
    setCtxDocId(null)
    setCtxBusy({ done: 0, total: 1 }); setCtxMsg(null)
    const isCancelled = () => ctxCancelledRef.current || gen !== ctxGenRef.current
    const isStale = () => gen !== ctxGenRef.current || getSessionsCurrent() !== targetConversationId
    try {
      if (isCancelled()) return
      const res = await executeDocumentContext({ targetConversationId, documentId: docId, fileName, pageCount: 0, selection, isCancelled, isStale, onProgress: (p) => { if (gen === ctxGenRef.current) setCtxBusy({ done: p.done, total: p.total }) } })
      if (gen !== ctxGenRef.current) return
      if (!res.ok && res.error) setCtxMsg(localizedErrorText(res.error, 'Unable to add the PDF context to the chat.'))
      else if (res.ok) setCtxMsg(tx('已加入当前对话 · ' + res.count + ' 页', 'Added to current chat · ' + res.count + ' pages'))
    } catch { if (gen === ctxGenRef.current) setCtxMsg(tx('无法生成上下文。', 'Unable to build context.')) }
    finally { if (gen === ctxGenRef.current) { setCtxBusy(null); setCtxDocId(null); ctxOpRef.current = null } }
  }
  function cancelCtx() { ctxCancelledRef.current = true; ctxGenRef.current++ }

  const refresh = useCallback(async () => {
    try { setSummaries(await listDocumentSummaries()) } catch { setSummaries([]) }
  }, [])
  useEffect(() => { if (open) void refresh() }, [open, refresh])

  const displaySummaries = useMemo(() => sortDocuments(summaries, sortKey), [summaries, sortKey])
  const onSortChange = (key: DocumentSortKey) => { setSortKeyState(key); saveSortPreference(key) }

  // ---- finalize a resolved import (writes the document, opens the Reader) ----
  const finalizeResolved = useCallback(async (analysis: ImportAnalysis, resolvedName: string, f: File) => {
    setImporting(true); setError(null)
    try {
      const id = await createDocumentFromImport({
        fileName: resolvedName, originalFileName: analysis.fileName, pageCount: analysis.pageCount,
        chapters: analysis.chapters, chapterSource: analysis.chapterSource, sourceBlob: f,
        contentHash: analysis.contentHash, fastFingerprint: analysis.fastFingerprint,
      })
      await refresh()
      documentUiActions.openReader(id)
    } catch (e) {
      setError(e instanceof PdfError ? pdfErrorMessage(e.kind) : tx('无法导入该 PDF。', 'Unable to import this PDF.'))
    } finally { setImporting(false) }
  }, [refresh])

  // ---- import entrypoint: analyze, then either create or surface a conflict ----
  const importFile = async (f: File) => {
    setImporting(true); setError(null); setPendingImport(null); setCustomName(null); setCustomNameErr(null)
    try {
      const analysis = await analyzeImport(f)
      if (analysis.conflict.kind === 'none') {
        await finalizeResolved(analysis, analysis.fileName, f)
      } else {
        setPendingImport({ analysis, file: f })
      }
    } catch (e) {
      setError(e instanceof PdfError ? pdfErrorMessage(e.kind) : tx('无法导入该 PDF。', 'Unable to import this PDF.'))
    } finally { setImporting(false) }
  }

  const existingNames = useMemo(() => new Set(summaries.map(s => s.fileName)), [summaries])
  const nameConflict = pendingImport?.analysis.conflict.kind === 'name-conflict' ? pendingImport.analysis.conflict : null
  const duplicateConflict = pendingImport?.analysis.conflict.kind === 'exact-duplicate' ? pendingImport.analysis.conflict : null

  const onDuplicateOpenExisting = () => { if (!duplicateConflict) return; setPendingImport(null); documentUiActions.openReader(duplicateConflict.existingDocumentId) }
  const onDuplicateImportCopy = async () => {
    const p = pendingImport; if (!p) return
    const resolved = nextAvailableName(p.analysis.fileName, existingNames)
    setPendingImport(null)
    await finalizeResolved(p.analysis, resolved, p.file)
  }
  const onNameConflictSaveSuggested = () => {
    const p = pendingImport; if (!p || !nameConflict) return
    setPendingImport(null)
    void finalizeResolved(p.analysis, nameConflict.suggestedName, p.file)
  }
  const onNameConflictOpenCustom = () => { const p = pendingImport; if (!p) return; setCustomName(nameConflict?.suggestedName ?? p.analysis.fileName); setCustomNameErr(null) }
  const onNameConflictCustomCommit = async () => {
    const p = pendingImport; if (!p) return
    const s = sanitizeFileName(customName ?? '')
    if (!(customName ?? '').trim()) { setCustomNameErr(tx('文件名不能为空。', 'File name cannot be empty.')); return }
    if (existingNames.has(s)) { setCustomNameErr(tx('文件名已被占用，请更换。', 'That file name is already in use.')); return }
    setPendingImport(null); setCustomName(null)
    await finalizeResolved(p.analysis, s, p.file)
  }

  // ---- rename (B4) ----
  const startRename = (d: DocumentSummary) => { setRenameId(d.id); setRenameName(d.fileName); setRenameErr(null); setMenuOpenId(null) }
  const commitRename = async () => {
    if (!renameId) return
    const trimmed = renameName.trim()
    if (!trimmed) { setRenameErr(tx('文件名不能为空。', 'File name cannot be empty.')); return }
    setImporting(true); setError(null); setRenameErr(null)
    try {
      await renameDocument(renameId, sanitizeFileName(trimmed))
      setRenameId(null); await refresh()
    } catch (e) { setRenameErr(e instanceof DocumentNameConflictError ? tx('已存在同名文件。', 'A file with that name already exists.') : tx('重命名失败，请重试。', 'Rename failed. Try again.')) }
    finally { setImporting(false) }
  }
  const cancelRename = () => { setRenameId(null); setRenameName(''); setRenameErr(null) }

  // ---- delete (B10) ----
  const doDelete = async () => {
    if (!confirmDelete) return
    setError(null); setImporting(true)
    try { await deleteDocument(confirmDelete.id); setConfirmDelete(null); await refresh() }
    catch { setError(tx('删除失败，请重试。', 'Delete failed. Try again.')) }
    finally { setImporting(false) }
  }

  if (!open) return null
  return (
    <div className={css.overlay} data-testid="document-library">
      <div className={css.head}>
        <span className={css.title}>{tx('文件', 'Files')}</span>
        <div className={css.headBtns}>
          <select className={css.sortSelect} data-testid="library-sort" aria-label={tx('排序', 'Sort')} value={sortKey} onChange={e => onSortChange(e.target.value as DocumentSortKey)}>
            {DOCUMENT_SORT_KEYS.map(k => <option key={k} value={k}>{localizedDocumentSort(k)}</option>)}
          </select>
          <input ref={fileRef} type="file" accept=".pdf,application/pdf" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = '' }} />
          <button className={css.primaryBtn} data-testid="library-import" disabled={importing} onClick={() => fileRef.current?.click()}>{importing ? tx('正在导入…', 'Importing…') : tx('导入 PDF', 'Import PDF')}</button>
          <button className={css.closeBtn} data-testid="library-close" onClick={documentUiActions.close}>{tx('关闭', 'Close')}</button>
        </div>
      </div>
      {error && <div className={css.error} data-testid="library-error">{error}</div>}
      {displaySummaries.length === 0 ? (
        <div className={css.empty} data-testid="library-empty">
          <div>{tx('还没有本地文件。', 'No local files yet.')}</div>
          <div className={css.emptyHint}>{tx('导入一份 PDF 开始阅读。', 'Import a PDF to start reading.')}</div>
          <button className={css.primaryBtn} data-testid="library-empty-import" onClick={() => fileRef.current?.click()}>{tx('导入 PDF', 'Import PDF')}</button>
        </div>
      ) : (
        <div className={css.list}>
          {displaySummaries.map(d => (
            <div className={css.card} key={d.id} data-testid={'doc-card-' + d.id}>
              <button className={css.cardMain} data-testid={'doc-open-' + d.id} onClick={() => documentUiActions.openReader(d.id)}>
                <div className={css.cardTitle}>{d.fileName}</div>
                <div className={css.cardMeta}>PDF · {tx(d.pageCount + ' 页', d.pageCount + ' pages')} · {formatBytes(d.fileSize)}</div>
                <div className={css.cardMeta}>
                  {d.lastReadPage > 0 ? tx('上次阅读：第 ' + d.lastReadPage + ' 页', 'Last read: page ' + d.lastReadPage) : tx('尚未阅读', 'Not read yet')}
                  {d.lastReadAt > 0 ? ' · ' + relTimeLabel(d.lastReadAt) : ''}
                  {d.chapterCount > 0 ? tx(' · 有目录', ' · Has outline') : tx(' · 无目录', ' · No outline')}
                </div>
              </button>
              <div className={css.cardActions}>
                <button className={css.actionBtn} data-testid={'doc-context-' + d.id} onClick={() => { setMenuOpenId(null); setCtxMsg(null); setCtxDocId(d.id) }}>{tx('加入对话', 'Add to chat')}</button>
                <div className={css.menuWrap}>
                  <button className={css.menuBtn} data-testid={'doc-menu-' + d.id} aria-label={tx('更多操作', 'More actions')} title={tx('更多操作', 'More actions')} onClick={() => setMenuOpenId(o => o === d.id ? null : d.id)}>⋯</button>
                  {menuOpenId === d.id && (
                    <div className={css.menu} data-testid={'doc-menu-pop-' + d.id}>
                      <button className={css.menuItem} data-testid={'doc-rename-' + d.id} onClick={() => startRename(d)}>{tx('重命名', 'Rename')}</button>
                      <button className={css.menuItem + ' ' + css.danger} data-testid={'doc-delete-' + d.id} onClick={() => { setMenuOpenId(null); setConfirmDelete(d) }}>{tx('删除', 'Delete')}</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {ctxDocId && (
        <DocumentContextPicker
          documentId={ctxDocId}
          onCancel={() => { setCtxDocId(null); setCtxMsg(null) }}
          onAdd={(selection) => { void addFromPicker(selection) }}
        />
      )}
      {ctxBusy && (
        <div className={css.error} data-testid="library-ctx-progress">
          <span>{tx('正在准备 AI Context ' + ctxBusy.done + ' / ' + ctxBusy.total + ' 页', 'Preparing AI context ' + ctxBusy.done + ' / ' + ctxBusy.total + ' pages')}</span>
          <button type="button" className={css.ctxCancel} data-testid="library-ctx-cancel" onClick={cancelCtx}>{tx('取消', 'Cancel')}</button>
        </div>
      )}
      {ctxMsg && !ctxDocId && <div className={css.error} data-testid="library-ctx-msg">{ctxMsg}</div>}

      {/* ---- rename dialog (B4) ---- */}
      {renameId && (
        <div className={css.dialogBackdrop} data-testid="rename-dialog">
          <div className={css.dialog}>
            <div className={css.dialogTitle}>{tx('重命名', 'Rename')}</div>
            <input className={css.renameInput} data-testid="rename-input" value={renameName} autoFocus onChange={e => setRenameName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void commitRename() } }} />
            {renameErr && <div className={css.dialogErr} data-testid="rename-error">{renameErr}</div>}
            <div className={css.dialogBtns}>
              <button className={css.secondaryBtn} data-testid="rename-cancel" onClick={cancelRename}>{tx('取消', 'Cancel')}</button>
              <button className={css.primaryBtn} data-testid="rename-save" disabled={importing} onClick={() => void commitRename()}>{tx('保存', 'Save')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ---- delete confirm (B10) ---- */}
      {confirmDelete && (
        <div className={css.dialogBackdrop} data-testid="delete-dialog">
          <div className={css.dialog}>
            <div className={css.dialogTitle}>{tx('删除《' + confirmDelete.fileName + '》？', 'Delete “' + confirmDelete.fileName + '”?')}</div>
            <div className={css.dialogText}>{tx('删除会移除保存在当前浏览器中的原始 PDF 和阅读进度。聊天中已经生成并保存的 PDF 页面 Context 不会因此删除。', 'This removes the original PDF and reading progress from this browser. PDF page context already saved in chats is not removed.')}</div>
            <div className={css.dialogBtns}>
              <button className={css.secondaryBtn} data-testid="delete-cancel" onClick={() => setConfirmDelete(null)}>{tx('取消', 'Cancel')}</button>
              <button className={css.primaryBtn + ' ' + css.danger} data-testid="delete-confirm" disabled={importing} onClick={() => void doDelete()}>{tx('删除', 'Delete')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ---- import conflict dialogs (B6/B7) ---- */}
      {(duplicateConflict || nameConflict) && (
        <div className={css.dialogBackdrop} data-testid="import-conflict">
          <div className={css.dialog}>
            {duplicateConflict ? (
              <>
                <div className={css.dialogTitle}>{tx('检测到这份文件已经存在', 'This file already exists')}</div>
                <div className={css.dialogText}>{tx('《' + duplicateConflict.existingFileName + '》已在资料库中。该文件内容与将要导入的文件完全一致。', '“' + duplicateConflict.existingFileName + '” is already in the library and has identical content.')}</div>
                <div className={css.dialogBtns}>
                  <button className={css.primaryBtn} data-testid="duplicate-open-existing" onClick={onDuplicateOpenExisting}>{tx('打开已有文件', 'Open existing file')}</button>
                  <button className={css.secondaryBtn} data-testid="duplicate-import-copy" onClick={() => void onDuplicateImportCopy()}>{tx('仍然导入副本', 'Import a copy')}</button>
                  <button className={css.secondaryBtn} data-testid="duplicate-cancel" onClick={() => { setPendingImport(null); setCustomName(null) }}>{tx('取消', 'Cancel')}</button>
                </div>
              </>
            ) : nameConflict ? (
              <>
                <div className={css.dialogTitle}>{tx('资料库中已存在同名文件', 'A file with this name already exists')}</div>
                <div className={css.dialogText}>{tx('《' + nameConflict.baseFileName + '》已在资料库中，但内容不同。请选择保存方式。', '“' + nameConflict.baseFileName + '” is already in the library but has different content. Choose how to save it.')}</div>
                <div className={css.dialogBtns}>
                  <button className={css.primaryBtn} data-testid="name-save-suggested" onClick={onNameConflictSaveSuggested}>{tx('保存为 ', 'Save as ')}{nameConflict.suggestedName}</button>
                  <button className={css.secondaryBtn} data-testid="name-custom" onClick={onNameConflictOpenCustom}>{tx('自定义名称', 'Custom name')}</button>
                  <button className={css.secondaryBtn} data-testid="name-cancel" onClick={() => { setPendingImport(null); setCustomName(null) }}>{tx('取消', 'Cancel')}</button>
                </div>
                {customName !== null && (
                  <div className={css.customWrap}>
                    <input className={css.renameInput} data-testid="name-custom-input" value={customName} autoFocus onChange={e => setCustomName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void onNameConflictCustomCommit() } }} />
                    {customNameErr && <div className={css.dialogErr} data-testid="name-custom-error">{customNameErr}</div>}
                    <div className={css.dialogBtns}>
                      <button className={css.primaryBtn} data-testid="name-custom-confirm" disabled={importing} onClick={() => void onNameConflictCustomCommit()}>{tx('确认', 'Confirm')}</button>
                    </div>
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

function localizedDocumentSort(key: DocumentSortKey): string {
  const english: Record<DocumentSortKey, string> = {
    'last-read': 'Recently read', 'last-import': 'Recently imported', 'name-asc': 'File name A–Z',
    'name-desc': 'File name Z–A', pages: 'Page count', size: 'File size',
  }
  return tx(DOCUMENT_SORT_LABELS[key], english[key])
}

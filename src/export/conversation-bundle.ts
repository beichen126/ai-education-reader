
// Conversation -> Markdown + images ZIP export (Stage 9.5, Part A2). Browser-local.
// Builds ONE ZIP containing conversation.md + images/<safe-name>.<ext>, referencing
// images with RELATIVE paths so the bundle is self-contained. Missing/unreadable
// attachments FAIL the whole export (never a "complete" bundle with missing media).
import { zipSync, strToU8 } from 'fflate'
import { getConversation, getAttachmentRow, getAnnotationsByConversation } from '../storage/storage'
import { readBinary } from '../storage/binary-store'
import { annotateMessageSource } from './markdown'
import type { Conversation } from '../engine/types'
import type { Annotation } from '../annotations/annotation-types'

export class ConversationBundleError extends Error {
  constructor(message: string) { super(message); this.name = 'ConversationBundleError' }
}

/** Sanitize a filename to a single safe path segment (no slash, backslash, NUL, or '..'). */
export function sanitizeAttachmentName(name: string): string {
  const base = String(name || 'image').replace(/[\/\\]+/g, '').replace(/\u0000/g, '').trim()
  const extMatch = /\.([A-Za-z0-9]+)$/.exec(base)
  const ext = extMatch ? extMatch[1].toLowerCase() : 'png'
  const stemInput = extMatch ? base.slice(0, base.length - extMatch[0].length) : base
  const safeStem = stemInput.replace(/[\s]+/g, '_').replace(/[^\w\u4e00-\u9fff-]+/g, '').slice(0, 60) || 'image'
  return safeStem + '.' + ext
}

/** Dedupe filename collisions deterministically AND globally collision-safe (blocker 0.5).
 *  Uses an occupied-name Set so an EXPLICIT input name can never collide with an
 *  auto-generated suffix: every result name is unique, i.e. new Set(result).size === result.length.
 *  Deterministic reservation: the first input claims `figure.png`; the second identical becomes
 *  `figure-2.png`; an explicit `figure-2.png` later claims `figure-2-2.png` if `figure-2.png` is taken. */
export function dedupeNames(names: string[]): string[] {
  const occupied = new Set<string>()
  return names.map(raw => {
    const base = sanitizeAttachmentName(raw)
    const dot = base.lastIndexOf('.')
    const stem = dot > 0 ? base.slice(0, dot) : base
    const ext = dot > 0 ? base.slice(dot) : ''
    let candidate = base
    let n = 2
    while (occupied.has(candidate)) {
      candidate = stem + '-' + n + ext
      n++
    }
    occupied.add(candidate)
    return candidate
  })
}

async function readAttachmentBytes(id: string): Promise<Uint8Array> {
  const row = await getAttachmentRow(id)
  if (!row) throw new ConversationBundleError('本地附件数据缺失，无法导出完整 ZIP：' + id.slice(0, 8))
  let blob: Blob | undefined
  if (row.binary) { try { blob = await readBinary(row.binary) } catch { blob = undefined } }
  else blob = row.blob instanceof Blob ? row.blob : undefined
  if (!blob) throw new ConversationBundleError('本地附件数据缺失，无法导出完整 ZIP：' + id.slice(0, 8))
  return new Uint8Array(await blob.arrayBuffer())
}

/** Markdown with a readable relative image reference appended after each message. */
function buildMarkdown(conv: Conversation, anns: Annotation[], imageRefsByMsg: Map<string, string[]>): string {
  const byMsg = new Map<string, Annotation[]>()
  for (const a of anns) { const l = byMsg.get(a.messageId) || []; l.push(a); byMsg.set(a.messageId, l) }
  const out: string[] = ['# ' + (conv.title || '未命名会话'), '']
  for (const m of conv.messages) {
    const label = m.role === 'assistant' ? 'AI' : '用户'
    const mark = byMsg.get(m.id)
    const body = mark && mark.length ? annotateMessageSource(m.content, m.id, mark) : m.content
    out.push('## ' + label, '', body)
    const refs = imageRefsByMsg.get(m.id)
    if (refs && refs.length) out.push('', ...refs)
    out.push('')
  }
  return out.join('\n').replace(/\n+$/, '\n')
}

export type ConversationBundle = { blob: Blob; zipName: string }

export async function buildConversationBundle(convId: string): Promise<ConversationBundle> {
  const conv = await getConversation(convId)
  if (!conv) throw new ConversationBundleError('会话不存在。')
  const anns: Annotation[] = await getAnnotationsByConversation(convId)

  // Collect images in message order (dedupe across the whole conversation).
  const imageIds: string[] = []
  for (const m of conv.messages) for (const id of m.images) if (!imageIds.includes(id)) imageIds.push(id)
  // Display name: prefer the attachment's stored meta name (readable), fall back to image-N.
  const baseNames = await Promise.all(imageIds.map(async (id, i) => { const row = await getAttachmentRow(id); return (row && row.meta && typeof row.meta.name === 'string' && row.meta.name.trim()) ? row.meta.name : ('image-' + (i + 1)) }))
  const names = dedupeNames(baseNames)
  const refByMsg = new Map<string, string[]>()
  for (const m of conv.messages) {
    const refs = m.images.map(id => { const idx = imageIds.indexOf(id); return '![附件](' + (idx >= 0 ? 'images/' + names[idx] : 'images/' + id) + ')' })
    refByMsg.set(m.id, refs)
  }
  const md = buildMarkdown(conv, anns, refByMsg)
  const files: Record<string, Uint8Array> = { 'conversation.md': strToU8(md) }
  for (let i = 0; i < imageIds.length; i++) files['images/' + names[i]] = await readAttachmentBytes(imageIds[i])
  const zipped = zipSync(files)
  const zipName = ((conv.title || 'conversation').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 40) || 'conversation') + '.zip'
  return { blob: new Blob([zipped as unknown as BlobPart], { type: 'application/zip' }), zipName }
}

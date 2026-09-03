import { idbScan } from './idb'
import { isOpfsAvailable, isStoragePersistent } from './binary-store'

export type StorageDiagnostics = {
  originUsageBytes?: number
  originQuotaBytes?: number
  attachmentCount: number
  attachmentBytes: number
  documentCount: number
  documentBytes: number
  totalBytes: number
  opfsSupported: boolean
  storagePersistent?: boolean
  opfsDocumentCount: number
  opfsDocumentBytes: number
  opfsAttachmentCount: number
  opfsAttachmentBytes: number
  idbBinaryCount: number
  idbBinaryBytes: number
  legacyBinaryCount: number
}

function trimZeros(s: string): string { if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s }

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return Math.round(bytes) + ' B'
  const kb = bytes / 1024
  if (kb < 1024) return trimZeros(kb.toFixed(1)) + ' KB'
  const mb = kb / 1024
  if (mb < 1024) return trimZeros(mb.toFixed(1)) + ' MB'
  return trimZeros((mb / 1024).toFixed(2)) + ' GB'
}

// Storage diagnostics count from PERSISTED METADATA (meta.size / fileSize / StoredBinary.size).
// It NEVER reads file bytes (no getFile/arrayBuffer/base64) just to compute usage.
export async function getStorageDiagnostics(): Promise<StorageDiagnostics> {
  let usage: number | undefined
  let quota: number | undefined
  try {
    const nav = typeof navigator !== 'undefined' ? (navigator as any) : undefined
    const estimate = nav?.storage?.estimate
    if (typeof estimate === 'function') {
      const r = await estimate.call(nav.storage)
      if (r && typeof r.usage === 'number') usage = r.usage
      if (r && typeof r.quota === 'number') quota = r.quota
    }
  } catch { /* feature unavailable */ }
  let attachmentCount = 0; let attachmentBytes = 0;
  let opfsAttachmentCount = 0; let opfsAttachmentBytes = 0;
  let idbBinaryBytes = 0; let idbBinaryCount = 0; let legacyBinaryCount = 0;
  try {
    await idbScan('attachments', (row) => {
      attachmentCount++;
      const size = row?.meta?.size ?? row?.binary?.size ?? row?.blob?.size ?? 0;
      attachmentBytes += size;
      if (row?.binary?.storage === 'opfs') { opfsAttachmentCount++; opfsAttachmentBytes += row.binary.size }
      else if (row?.binary?.storage === 'idb') { idbBinaryCount++; idbBinaryBytes += row.binary.size }
      else if (row?.blob) { legacyBinaryCount++ }
    });
  } catch { /* scan failure -> zeros */ }
  let documentCount = 0; let documentBytes = 0;
  let opfsDocumentCount = 0; let opfsDocumentBytes = 0;
  try {
    await idbScan('documents', (row) => {
      documentCount++;
      const size = row?.fileSize ?? row?.source?.size ?? row?.sourceBlob?.size ?? 0;
      documentBytes += size;
      if (row?.source?.storage === 'opfs') { opfsDocumentCount++; opfsDocumentBytes += row.source.size }
      else if (row?.source?.storage === 'idb') { idbBinaryCount++; idbBinaryBytes += row.source.size }
      else if (row?.sourceBlob) { legacyBinaryCount++ }
    });
  } catch { /* old DB */ }
  const opfsSupported = await isOpfsAvailable();
  let storagePersistent: boolean | undefined
  try { storagePersistent = await isStoragePersistent() } catch { /* unavailable */ }
  return {
    ...(usage !== undefined ? { originUsageBytes: usage } : {}),
    ...(quota !== undefined ? { originQuotaBytes: quota } : {}),
    attachmentCount, attachmentBytes, documentCount, documentBytes,
    totalBytes: attachmentBytes + documentBytes,
    opfsSupported,
    ...(storagePersistent !== undefined ? { storagePersistent } : {}),
    opfsDocumentCount, opfsDocumentBytes, opfsAttachmentCount, opfsAttachmentBytes,
    idbBinaryCount, idbBinaryBytes, legacyBinaryCount,
  };
}

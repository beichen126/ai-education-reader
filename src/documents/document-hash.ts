// Content hashing for Document Library duplicate detection (Agent B, B8).
// Layered dedup uses TWO digests over the same payload:
//   - fastFingerprint: SHA-256 over FIRST + LAST 4 KiB only (cheap candidate filter).
//   - contentHash:     SHA-256 over the ENTIRE binary (the ONLY value that can assert
//                      "exact duplicate").
// crypto.subtle.digest is NOT a streaming hash, so it is never run over the whole library at
// startup — every hash is computed lazily on the import / duplicate-candidate path only.

const HEAD_TAIL = 4096

function isTextEncoderBufferSource(c: Uint8Array): ArrayBuffer {
  // Transfer the view so open Uint8Array subarrays still hash correctly.
  return c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength) as ArrayBuffer
}

function hex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

async function digestSHA256(chunks: Uint8Array[]): Promise<string> {
  const subtle = (globalThis as any).crypto?.subtle
  if (!subtle?.digest) throw new Error('crypto.subtle unavailable: cannot compute document hash')
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { buf.set(c, off); off += c.byteLength }
  const h = await subtle.digest('SHA-256', isTextEncoderBufferSource(buf))
  return hex(new Uint8Array(h))
}

export type DocumentHashes = { contentHash: string; fastFingerprint: string }

/** Cheap stage-2 fingerprint: combine the first and last HEAD_TAIL bytes of the blob. */
export async function computeFastFingerprint(blob: Blob): Promise<string> {
  const size = blob.size
  if (size === 0) {
    const head = new Uint8Array(await blob.slice(0, 0).arrayBuffer())
    return digestSHA256([head])
  }
  const head = new Uint8Array(await blob.slice(0, Math.min(HEAD_TAIL, size)).arrayBuffer())
  const tail = new Uint8Array(await blob.slice(Math.max(0, size - HEAD_TAIL), size).arrayBuffer())
  return digestSHA256([head, tail])
}

/** Stage-3 full content digest (== exact duplicate assertion). */
export async function computeContentHash(blob: Blob): Promise<string> {
  const full = new Uint8Array(await blob.arrayBuffer())
  return digestSHA256([full])
}

/** Compute both digests in one pass over the given blob (import path only). */
export async function computeDocumentHashes(blob: Blob): Promise<DocumentHashes> {
  return { contentHash: await computeContentHash(blob), fastFingerprint: await computeFastFingerprint(blob) }
}

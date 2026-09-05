// Document model — the persistent "original learning material" layer (Stage 9.2A).
// One document is a full original file (currently always a PDF) kept in the
// browser's IndexedDB as a FIRST-CLASS object, independent of any conversation:
//    Document  (original material, global ownership)
//      └─ Chapter  (bookmark / AI TOC / manual structure)
//           └─ Context  (the page set actually sent to the AI)

/** Structural chapter of a document. Persistent business model — NOT the raw
 * pdfjs PdfOutlineItem (that stays a parse artifact in src/pdf). */
export type ChapterNode = {
  id: string
  title: string
  level: number
  /** Resolved page range when available. null is legitimate: bookmark parent
   * nodes or unresolved destinations must not get fabricated page numbers. */
  startPage: number | null
  endPage: number | null
  selectable: boolean
  source: 'native' | 'ai-toc' | 'manual'
  children: ChapterNode[]
}

export type DocumentChapterSource = 'none' | 'native' | 'ai-toc' | 'manual' | 'mixed'

export type LearningDocument = {
  id: string
  kind: 'pdf'
  fileName: string
  mimeType: 'application/pdf'
  fileSize: number
  pageCount: number
  /** The ORIGINAL source file. Lives only in the browser; never enters any AI request. */
  sourceBlob: Blob
  chapters: ChapterNode[]
  chapterSource: DocumentChapterSource
  /** Last page the user actually read. 0 = never read (metadata only, no binary read). */
  lastReadPage: number
  /** Most recent READING activity (page turn / Reader open). Semantically distinct from
   *  updatedAt (metadata mutation). Backfilled from updatedAt/createdAt for pre-v1.1.1 records. */
  lastReadAt: number
  /** Original import origin (PDF today; future PPT/PPTX conversion still lands here). */
  importSource?: { kind: 'pdf' | 'ppt' | 'pptx'; originalFileName: string }
  /** Full SHA-256 of the source binary (content-hash dedup stage 3). Lazy-computed only. */
  contentHash?: string
  /** Fast fingerprint (first+last chunk digest) — dedup stage 2 candidate filter. */
  fastFingerprint?: string
  createdAt: number
  updatedAt: number
}

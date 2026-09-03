# Product Roadmap

Long-term direction. Planning only — items here are NOT scheduled or implemented yet.
Short, user-facing release notes live in CHANGELOG.md, not here.

## 1. OPFS storage — foundation implemented

Large binary items (original PDFs, larger attachments) are stored OPFS-first where the
browser supports it, with an automatic IndexedDB-inline fallback. IndexedDB keeps
metadata, ids, relations, settings, chapter trees and binary references. A background
migration moves legacy IndexedDB blobs into OPFS. Reserved follow-up work:

- better orphan GC (listReferencedOpfsPaths + cleanupUnreferencedOpfs exist; graceful 24h runtime GC not enabled)
- future PPTX / conversion binary assets in the same binary layer
- streaming backup/export (Backup V2 remains base64 JSON)

## 2. PPTX material library — Planned

Goal: accept PPT/PPTX as an import format for the material library. The canonical
internal reading format stays PDF: PPTX → local conversion/render → canonical PDF
document, then reuse Document / Chapter / Reader / Context. No separate PPT reader.

## 3. Export expansion — Planned

At least:
- Document → PDF with bookmarks
- Conversation → Markdown + images ZIP
- Annotated/study-material bundle

To be designed separately.

## 4. Dark mode — Planned

Based on the existing design tokens / CSS variables; system / light / dark. Never by
hard-coding black CSS per component.

## 5. PDF compatibility — evidence-triggered future item

Continue the real fixture corpus under test/fixtures/pdf-compat. If a stable class of
PDFs fails on a complete PDF.js runtime while PDFium/MuPDF succeeds, evaluate a
secondary renderer backend then.

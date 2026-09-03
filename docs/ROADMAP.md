# Product Roadmap

Long-term direction. Planning only — items here are NOT scheduled or implemented yet.
Short, user-facing release notes live in CHANGELOG.md, not here.

## 1. OPFS storage

Goal: move large blobs (original PDFs, future PPTX, larger attachments) from IndexedDB
blob storage to OPFS (Origin Private File System). IndexedDB keeps metadata, ids,
relations, settings.

Needs migration, atomic ownership, delete cleanup, a backup strategy, and an
unsupported-browser fallback. Not implemented yet.

## 2. PPTX material library

Goal: accept PPT/PPTX as an import format for the material library. The canonical
internal reading format stays PDF: PPTX → local conversion/render → canonical PDF
document, then reuse Document / Chapter / Reader / Context. No separate PPT reader.

## 3. Export expansion

At least:
- Document → PDF with bookmarks
- Conversation → Markdown + images ZIP
- Annotated/study-material bundle

To be designed separately.

## 4. Dark mode

Based on the existing design tokens / CSS variables; system / light / dark. Never by
hard-coding black CSS per component.

## 5. PDF compatibility

Continue the real fixture corpus under test/fixtures/pdf-compat. If a stable class of
PDFs fails on a complete PDF.js runtime while PDFium/MuPDF succeeds, evaluate a
secondary renderer backend then. Not before.

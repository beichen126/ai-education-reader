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

## 6. v1.0.0 shipped status

The following v1.0.0 items are SHIPPED and implemented (see CHANGELOG):

- Document Library → Context picker (reusable, three entry points; parent /
  multi-chapter / manual range / whole-document; metadata-only loading).
- Reader "加入对话" current-chapter ancestry + 选择其他章节 / 多章节.
- Export: Document → bookmarked PDF; Conversation → Markdown + images ZIP.
- Dark mode (system / light / dark, design tokens, persisted).

## 7. PPTX import — NOT SHIPPED (planned)

PPTX import is NOT shipped: v1.0.0 did not validate a browser-local
PPTX → canonical-PDF renderer against the project's fidelity gate, so the
feature is not enabled. The material library accepts PDF only.

Background: the browser OOXML → PDF renderer ecosystem is fragmented
(pptx-preview / pptx-kit-preview / reamkit), and the alternate routes
(LibreOffice server, WASM office suite, cloud conversion) are explicitly out
of scope / forbidden. No comparative fixture gate was committed this release.
The canonical-PDF philosophy (import → convert locally → reuse Document /
Chapter / Reader / Context, with no separate PPT reader) remains the future
plan. This does NOT block v1.0.0.

# AI Education Reader — v1.0.0 Release Checklist

This is BOTH the live release checkpoint and the permanent v1.0.0 release checklist.
It records exact completed work (commit SHAs) and the remaining mandatory gates.

## Completed commits (origin/main)

| Commit | SHA | Content |
|---|---|---|
| Part 0 (0.1–0.5) integrity seal | `e608d29` | storage + TOC integrity gaps |
| Part 0.6 AI TOC UX hotfix | `e7dfea0` | review layout, progress dialog, range select |
| Part A1 bookmarked PDF export | `c96a251` | pdf-outline-writer, Reader export action |
| Part 0.7 Document → Context picker | `380c61d` | shared picker, ancestry, multi-chapter, service |
| Part A2 Markdown + images ZIP | `47b35d9` | conversation-bundle, fflate ZIP |
| Part B system/light/dark themes | `a87571b` | theme.ts + use-theme + settings radio |

Baseline before this round: `c96a251`. Current tip of origin/main: `a87571b`.

## Feature status

- Document → Context picker: **Shipped**
- Reader ancestry / multi-chapter: **Shipped**
- Export bookmarked PDF: **Shipped**
- Export Markdown + images ZIP: **Shipped**
- Dark mode (system/light/dark): **Shipped**
- PPTX import: **GATED / NOT SHIPPED** (evidence in docs/ROADMAP.md §7) — does not block v1.0.0

## Remaining mandatory v1.0.0 gates NOT yet done

1. **README full rewrite** (hero, visual gallery, Mermaid, feature matrix, quick
   start, privacy, limitations). Current README is obsolete.
2. **README screenshots** from the real production build (docs/assets/readme/),
   via `scripts/capture-readme-assets.mjs` + `npm run docs:screenshots`.
   Required assets: 01-reader-context, 02-document-library,
   03-document-context-picker, 04-ai-toc-review, 05-chapter-editor,
   06-settings-byok, 07-mobile, 08-dark-mode (.webp).
3. **docs/ARCHITECTURE.md** (Document→Chapter→Context→Draft→Message→AI, PDF
   runtime, OPFS/IDB, AI TOC, Document→Context picker, backup, async ownership,
   export, PPTX if shipped).
4. **docs/TESTING.md** (unit, storage, PDF codec, E2E, responsive, AI mock,
   real paid smoke).
5. **CHANGELOG** `## [1.0.0] - 2026-09-04` (move finished user-visible items
   out of Unreleased); keep `## [Unreleased]` empty on top.
6. **Version**: package.json + package-lock root → `1.0.0`; remove product-status
   alpha wording.
7. **Full final regression**: npm ci, npm test, npm run test:pdf-codec,
   npm run typecheck, npm run build, plus all critical Edge E2E
   (ai-toc, toc-review-layout, document-context, toc-thumbnails, doc-reader,
   chapter-builder, native-toc, toc-layout, settings-byok, viewer-edge,
   responsive, stage2/4/5/6, opfs-storage, opfs-migration, theme,
   export-bookmarked-pdf, export-markdown-zip).
8. **README link/image validation + GitHub Pages production smoke.**
9. **Annotated tag `v1.0.0`** (message "AI Education Reader v1.0.0") only after
   gates pass; push tag; optionally create GitHub Release if gh CLI authenticated.

## Local only (NOT committed, cannot ship)

- `test/.playwright/e2e-stage4.mjs` local sourceBlob→source.size fixture fix.

## Known limitations (document in README)

- AI calls need BYOK; vision behavior depends on the configured model.
- Single PDF Context hard max 120 pages (soft confirm >30).
- Backup V2 base64 JSON has a large-library memory cost.
- Interactive PDF JS / 3D / media are out of scope.
- PPTX (planned) not shipped this round.

# AI Education Reader — v1.0.0 Release Checklist

This is BOTH the live release checkpoint and the permanent v1.0.0 release checklist.
It records exact completed work (commit SHAs) and the remaining mandatory gates.

## Completed (origin/main)

| Commit | SHA | Content |
|---|---|---|
| Part 0 (0.1–0.5) integrity seal | `e608d29` | storage + TOC integrity gaps |
| Part 0.6 AI TOC UX hotfix | `e7dfea0` | review layout, progress dialog, range select |
| Part A1 bookmarked PDF export | `c96a251` | pdf-outline-writer, Reader export action |
| Part 0.7 Document → Context picker | `380c61d` | shared picker, ancestry, multi-chapter, service |
| Part A2 Markdown + images ZIP | `47b35d9` | conversation-bundle, fflate ZIP |
| Part B system/light/dark themes | `a87571b` | theme.ts + use-theme + settings radio |
| v1 docs checkpoint | `3e55cd2` | ROADMAP §6/§7 + this checklist |
| RC correctness seal | `58eb02d` | picker stage model, temp PdfSession, ZIP collision, theme single-source, real-draft E2E |
| Dark-theme calibration + study-highlight | `c0cf6d1` | brand-primary blue, restrained surfaces, `--dsw-specific-study-highlight`, computed-style E2E |
| Hardening round (this pass) | `8782a77`→`14cb37f` | idb commit/versionchange, SSE framing, send/draft atomicity, stream durability, attachment-draft ownership + orphan GC, reader context unify, markdown link sanitize, vision capability + atomic settings, hydrate deprecation + after-boot GC, CI gate |

Current tip of origin/main: **`14cb37f`** (12 commits since `c0cf6d1`).

## STATUS: v1.0.0 RELEASE CANDIDATE — NOT RELEASED

- No `v1.0.0` git tag or GitHub Release exists yet.
- package.json / package-lock / APP_VERSION remain `0.1.0-alpha.3` (candidate), NOT `1.0.0`.

## Feature status

- Document → Context picker: **Shipped**
- Reader ancestry / multi-chapter: **Shipped**
- Export bookmarked PDF: **Shipped**
- Export Markdown + images ZIP: **Shipped**
- Dark mode (system/light/dark): **Shipped**
- Study-highlight (annotation) dark mode: **Shipped**
- PPTX import: **NOT SHIPPED** (evidence in docs/ROADMAP.md §7) — does not block v1.0.0


## Release documentation (this round)

- README.md rewritten (hero, gallery, Mermaid, feature matrix, quick start, BYOK, privacy, limitations).
- Screenshots generated from real production build → docs/assets/readme/*.webp (8 images).
- docs/ARCHITECTURE.md created.
- docs/TESTING.md created.
- CHANGELOG `## [1.0.0] - 2026-09-04` (moved Unreleased content; empty Unreleased on top).
- Version stays **0.1.0-alpha.3** (release candidate — NOT bumped to 1.0.0, no release claimed). README badge says 'v1.0.0 release candidate'.

## Remaining before tagging v1.0.0

1. Full final regression: `npm ci`, `npm test`, `npm run test:pdf-codec`, `npm run typecheck`, `npm run build`, plus critical Edge E2E (document-context, document-reader, theme, theme-computed, ai-toc, toc-review-layout, toc-thumbnails, chapter-builder, native-toc, toc-layout, settings-byok, viewer-edge, responsive, opfs-storage, opfs-migration).
2. README link/image validation + GitHub Pages production smoke.
3. Annotated tag `v1.0.0` (message "AI Education Reader v1.0.0") after gates pass; push tag; GitHub Release if gh CLI authenticated.

## Local only (NOT committed, cannot ship)

- `test/.playwright/e2e-stage4.mjs` local sourceBlob→source.size fixture fix.

## Known limitations (document in README)

- AI calls need BYOK; vision behavior depends on the configured model.
- Single PDF Context hard max 120 pages (soft confirm >30).
- Backup V2 base64 JSON has a large-library memory cost.
- Interactive PDF JS / 3D / media are out of scope.
- PPTX (planned) not shipped this round.

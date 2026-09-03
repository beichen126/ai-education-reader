# PDF Static-Visual Compatibility Corpus

Home for minimal, redistribution-safe PDF fixtures used to pin down PDF static page
visual-compatibility regressions. Categories:

- `text-vector/` — text + vector graphics (no image codec dependency).
- `jpeg/` — plain DCT/JPEG image pages (browser-native codec).
- `jpx/` — JPEG2000 (JPXDecode) pages (OpenJPEG WASM decoder).
- `jbig2/` — JBIG2 bitonal scan pages (JBIG2 WASM decoder).
- `fonts/` — embedded / CID / non-embedded font + CMap cases.
- `transparency/` — transparency / soft masks / patterns / shadings.
- `rotation/` — page rotation / non-default CropBox & MediaBox / landscape.
- `malformed/` — corrupt / unsupported docs used to assert error classification.

Policy: only add a fixture that reproduces a REAL compatibility bug. When a bug is
confirmed, extract the smallest legal fixture here, add a non-white / geometry / error
assertion, and fix the runtime backend. NEVER write a per-filename workaround in code.

Licensing: redistributable fixtures are attributed in `test/fixtures/THIRD_PARTY.md`.
Files generated locally by this project are original (MIT).

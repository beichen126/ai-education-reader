# Android accelerators

The external Android project lives at `F:/Android/projects/ai-education-reader`.
Keep its existing Android 8.0 / API 26 minimum. The PDF accelerator uses the
API 21 `PdfRenderer` methods, not Android 15 PDF APIs. No extra native library,
Python runtime, paid service, or Google Play Services dependency is added.

After building the web application, synchronize before building the APK:

```powershell
python scripts/sync-android-native.py F:/Android/projects/ai-education-reader
& F:/Android/projects/ai-education-reader/scripts/build-release.ps1
```

## PDF

PDF.js continues to provide document metadata, outlines, coordinates and the web
fallback. Android renders both attachment images and reader page bitmaps on one
worker thread. Upload uses bounded, acknowledged 96 KiB chunks once per document
session. At most four native document handles remain open. Closed sessions release
their files and handles. Rendering cannot interrupt the system renderer in the
middle of a page; cancellation skips queued work and discards the active result.
An individual bitmap is bounded to a 1800 px edge and 3× scale.

Rendered JPEG files are identified by SHA-256 of the PDF, page and size. They are
served through the app's same-origin asset interception, with a 64 MiB / seven-day
LRU cache. Temporary source PDFs are private cache files removed at bridge shutdown;
the OS can also reclaim app cache. Native failure falls back to PDF.js and disables
further native attempts for that session. Missing bridges preserve older APK/web
behavior. Unsupported `createImageBitmap` retains the PDF.js display surface path.

## YouTube

The caption-only native HTTP attempt reads the watch-page player JSON and requests
the selected caption track. It fetches no video or page subresources. A failed or
unsupported response invokes the hidden WebView compatibility extractor once.
This is a small first-party HTTP extractor, not NewPipeExtractor or yt-dlp.

The native stage has a 16-second deadline and bounded responses; socket operations
have at most six-second timeouts. The whole extraction retains an 80-second budget.
Cancellation disconnects the HTTP request, cancels its worker and destroys any
fallback WebView. Generation IDs reject stale completion. Existing web transcript
storage caches successful results. Final errors retain the native-stage reason,
fallback stage, elapsed time and request ID for diagnosis.

Both paths run while the app process lives; these are not persistent OS jobs.
The complete PDF bridge was tested on an Android 16 emulator: upload, native render,
same-origin image fetch/decode, cache reuse, invalid pages and close behavior. JVM
subtitle tests and browser native/fallback tests also run. Android 8 compatibility
is checked by lint/API use; physical-device performance and live YouTube availability
still depend on the device/network and have not been benchmarked here.

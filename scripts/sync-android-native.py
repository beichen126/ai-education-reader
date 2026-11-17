"""Synchronize reviewed native sources into the external Android checkout."""
from pathlib import Path
import argparse

parser = argparse.ArgumentParser()
parser.add_argument('project', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
java = args.project / 'app/src/main/java/com/example/aieducationreader'
host = java / 'ui/web/WebAppScreen.kt'
source = host.read_text(encoding='utf8')
if 'import com.example.aieducationreader.bridge.PdfBridge' not in source:
    edits = [
        ('import com.example.aieducationreader.bridge.YoutubeBridge', 'import com.example.aieducationreader.bridge.PdfBridge\nimport com.example.aieducationreader.bridge.YoutubeBridge'),
        ('  var youtubeBridge by remember', '  var pdfBridge by remember { mutableStateOf<PdfBridge?>(null) }\n  var youtubeBridge by remember'),
        ('          val ytBridge = YoutubeBridge', '          val nativePdf = PdfBridge(ctx) { webView }\n          pdfBridge = nativePdf\n          addJavascriptInterface(nativePdf, "AndroidPdf")\n          val ytBridge = YoutubeBridge'),
        ('              val url = request.url', '              val url = request.url\n              nativePdf.intercept(url)?.let { return it }'),
        ('      youtubeBridge?.shutdown()', '      pdfBridge?.shutdown()\n      youtubeBridge?.shutdown()'),
    ]
    for before, after in edits:
        if before not in source:
            raise RuntimeError('Android host changed: missing integration anchor ' + before)
        source = source.replace(before, after, 1)
    host.write_bytes(source.encode('utf8'))
for relative in ['pdf/PdfBridge.kt', 'youtube/YoutubeBridge.kt', 'youtube/NativeYoutube.kt']:
    path = root / 'android' / relative
    (java / 'bridge' / path.name).write_bytes(path.read_bytes())
test = args.project / 'app/src/test/java/com/example/aieducationreader/bridge/NativeYoutubeTest.kt'
test.parent.mkdir(parents=True, exist_ok=True)
test.write_bytes((root / 'android/youtube/NativeYoutubeTest.kt').read_bytes())
(args.project / 'app/src/main/assets/android/youtube-extractor.js').write_bytes((root / 'extensions/youtube-bridge/extractor.js').read_bytes())
instrumented = args.project / 'app/src/androidTest/java/com/example/aieducationreader/bridge/PdfBridgeInstrumentedTest.kt'
instrumented.parent.mkdir(parents=True, exist_ok=True)
instrumented.write_bytes((root / 'android/pdf/PdfBridgeInstrumentedTest.kt').read_bytes())
print('Native PDF and subtitle sources synchronized.')

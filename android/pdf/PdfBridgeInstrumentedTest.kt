package com.example.aieducationreader.bridge

import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import android.net.Uri
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class PdfBridgeInstrumentedTest {
  class Result(private val result: CompletableFuture<String>) {
    @JavascriptInterface fun done(value: String) { result.complete(value) }
  }
  @Test fun rendersCachesAndClosesThroughActualWebView() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val bytes = ByteArrayOutputStream()
    val pdf = PdfDocument()
    try {
      val page = pdf.startPage(PdfDocument.PageInfo.Builder(300, 400, 1).create())
      page.canvas.drawText("PDF bridge test", 20f, 50f, Paint().apply { textSize = 20f })
      pdf.finishPage(page); pdf.writeTo(bytes)
    } finally { pdf.close() }
    val encoded = Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
    val result = CompletableFuture<String>()
    var web: WebView? = null
    var bridge: PdfBridge? = null
    val html = """<html><body><script>
      const pending=new Map(); let counter=0;
      window.addEventListener('message',e=>{const fn=pending.get(e.data.id);if(fn){pending.delete(e.data.id);fn(e.data)}});
      const call=payload=>new Promise(resolve=>{const id='test-'+(++counter);pending.set(id,resolve);AndroidPdf.request(id,JSON.stringify({doc:'document-test',...payload}))});
      (async()=>{try{
        await call({op:'begin'}); await call({op:'append',data:'$encoded'}); const opened=await call({op:'open'});
        const first=await call({op:'render',page:1,edge:600});if(first.error)throw Error(first.error);
        const image=await fetch(first.url);if(!image.ok)throw Error('image fetch');const blob=await image.blob();
        const bitmap=await createImageBitmap(blob);const width=bitmap.width,height=bitmap.height;bitmap.close();
        const second=await call({op:'render',page:1,edge:600});
        const invalid=await call({op:'render',page:99,edge:600});
        await call({op:'close'});const closed=await call({op:'render',page:1,edge:600});
        TestResult.done(JSON.stringify({width,height,pages:opened.pages,cached:first.url===second.url,invalid:!!invalid.error,closed:!!closed.error,size:blob.size}));
      }catch(e){TestResult.done(JSON.stringify({error:String(e)}))}})();
    </script></body></html>"""
    try {
      instrumentation.runOnMainSync {
        val view = WebView(instrumentation.targetContext); web = view
        val native = PdfBridge(instrumentation.targetContext) { view }; bridge = native
        view.settings.javaScriptEnabled = true
        view.addJavascriptInterface(native, "AndroidPdf")
        view.addJavascriptInterface(Result(result), "TestResult")
        view.webViewClient = object : WebViewClient() {
          override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            native.intercept(request.url)?.let { return it }
            return if (request.url.path == "/ai-education-reader/test.html") WebResourceResponse("text/html", "utf-8", html.byteInputStream()) else null
          }
        }
        view.loadUrl("https://appassets.androidplatform.net/ai-education-reader/test.html")
      }
      val value = JSONObject(result.get(60, TimeUnit.SECONDS))
      assertFalse(value.toString(), value.has("error"))
      assertEquals(450, value.getInt("width")); assertEquals(600, value.getInt("height"))
      assertEquals(1, value.getInt("pages")); assertTrue(value.getBoolean("cached"))
      assertTrue(value.getBoolean("invalid")); assertTrue(value.getBoolean("closed")); assertTrue(value.getInt("size") > 100)
    } finally { instrumentation.runOnMainSync { bridge?.shutdown(); web?.destroy() } }
  }
}

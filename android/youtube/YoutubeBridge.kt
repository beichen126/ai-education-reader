package com.example.aieducationreader.bridge

import android.annotation.SuppressLint
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceError
import android.webkit.WebResourceResponse
import android.util.Log
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import org.json.JSONTokener

/** Dedicated YouTube view, with no JavaScript interfaces exposed to YouTube. */
class YoutubeBridge(private val context: Context, private val reader: () -> WebView?) {
  private val handler = Handler(Looper.getMainLooper())
  private val network = java.util.concurrent.Executors.newSingleThreadExecutor()
  private var nativeRequest: NativeYoutube? = null
  private var nativeFuture: java.util.concurrent.Future<*>? = null
  private var nativeFailure: String? = null
  private var nativeTimeout: Runnable? = null
  private var pollTask: Runnable? = null
  private var startedAt = 0L
  private var stage = "loading"
  private var closed = false
  private var youtube: WebView? = null
  private var activeId: String? = null
  private var generation = 0
  private fun trusted(): Boolean {
    val uri = Uri.parse(reader()?.url ?: return false)
    return uri.scheme == "https" && uri.host == "appassets.androidplatform.net" && uri.path?.startsWith("/ai-education-reader/") == true
  }
  @JavascriptInterface
  fun extract(id: String, videoId: String, language: String) { handler.post {
    if (closed || !trusted() || !id.matches(Regex("[a-zA-Z0-9-]{1,100}")) || !videoId.matches(Regex("[a-zA-Z0-9_-]{11}")) || language !in listOf("auto","zh","en","ja","ko","es")) return@post
    if (activeId != null) { emit(id, JSONObject().put("error", "已有字幕提取任务").put("code", "BUSY").put("stage", stage)); return@post }
    try { start(id, videoId, language) } catch (e: Exception) { fail("INITIALIZATION_FAILED", "字幕任务初始化失败：${e.javaClass.simpleName}") }
  } }
  @JavascriptInterface
  fun cancel() { handler.post { fail("CANCELLED", "已取消") } }
  @JavascriptInterface
  fun cancelRequest(id: String) { handler.post { if (activeId == id) fail("CANCELLED", "已取消") } }
  fun shutdown() { handler.post { closed = true; fail("HOST_DESTROYED", "页面已关闭，请重新提取字幕"); network.shutdownNow() } }
  private fun fail(code: String, message: String) {
    finish(JSONObject().put("error", message).put("code", code).put("stage", stage).put("elapsedMs", System.currentTimeMillis() - startedAt).put("nativeFailure", nativeFailure))
  }
  private fun emit(id: String, value: JSONObject) {
    if (!trusted()) return
    value.put("channel", "reader-youtube-response").put("id", id)
    reader()?.evaluateJavascript("window.postMessage(${value},location.origin)", null)
  }
  private fun finish(value: JSONObject) {
    val id = activeId ?: return
    activeId = null; generation++
    nativeTimeout?.let { handler.removeCallbacks(it) }; nativeTimeout = null
    nativeRequest?.cancel(); nativeRequest = null
    nativeFuture?.cancel(true); nativeFuture = null
    pollTask?.let { handler.removeCallbacks(it) }; pollTask = null
    youtube?.let { view -> view.stopLoading(); (view.parent as? ViewGroup)?.removeView(view); view.destroy() }; youtube = null
    if (value.has("error")) Log.w("ReaderYoutube", "request=$id code=${value.optString("code")} stage=$stage elapsed=${System.currentTimeMillis() - startedAt}ms message=${value.optString("error")}")
    emit(id, value)
  }
  private fun start(id: String, videoId: String, language: String) {
    activeId = id; val token = ++generation
    startedAt = System.currentTimeMillis(); stage = "native-http"; nativeFailure = null
    val request = NativeYoutube(); nativeRequest = request
    nativeTimeout = Runnable {
      if (generation == token && activeId == id && !closed) {
        request.cancel(); nativeFuture?.cancel(true)
        nativeRequest = null; nativeFuture = null; nativeTimeout = null
        nativeFailure = "NATIVE_TIMEOUT"
        try { open(id, videoId, language) } catch (_: Exception) { fail("INITIALIZATION_FAILED", "字幕兼容模式启动失败") }
      }
    }
    handler.postDelayed(nativeTimeout!!, 16000)
    nativeFuture = network.submit {
      try {
        val data = request.extract(videoId, language)
        handler.post { if (generation == token && activeId == id && !closed) finish(JSONObject().put("data", data)) }
      } catch (error: Exception) {
        handler.post {
          if (generation == token && activeId == id && !closed) {
            nativeTimeout?.let { handler.removeCallbacks(it) }; nativeTimeout = null
            nativeFailure = error.message?.take(120) ?: error.javaClass.simpleName
            Log.i("ReaderYoutube", "request=$id native fallback=$nativeFailure")
            nativeRequest = null; nativeFuture = null
            try { open(id, videoId, language) } catch (_: Exception) { fail("INITIALIZATION_FAILED", "字幕兼容模式启动失败") }
          }
        }
      }
    }
  }
  @SuppressLint("SetJavaScriptEnabled")
  private fun open(id: String, videoId: String, language: String) {
    activeId = id; val token = ++generation
    stage = "webview-loading"
    val host = reader()?.rootView as? ViewGroup
    if (host == null) { fail("HOST_UNAVAILABLE", "阅读器页面尚未准备好，请重试"); return }
    val view = WebView(context).apply {
      alpha = 0f
      importantForAccessibility = android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
      isFocusable = false
      settings.mediaPlaybackRequiresUserGesture = true
      settings.loadsImagesAutomatically = false
      settings.javaScriptEnabled = true
      settings.domStorageEnabled = true
      settings.allowFileAccess = false
      settings.allowContentAccess = false
      settings.userAgentString = settings.userAgentString.replace(Regex("\\([^)]*\\)"), "(X11; Linux x86_64)").replace("Version/4.0 ", "").replace(" Mobile", "")
      webViewClient = object : WebViewClient() {
        override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
          if (generation == token && request?.isForMainFrame == true) fail("PAGE_NETWORK_${error?.errorCode}", "YouTube 页面加载失败：${error?.description}")
        }
        override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, error: WebResourceResponse?) {
          if (generation == token && request?.isForMainFrame == true) fail("HTTP_${error?.statusCode}", "YouTube 返回 HTTP ${error?.statusCode}，请检查网络后重试")
        }
        override fun onRenderProcessGone(view: WebView?, detail: android.webkit.RenderProcessGoneDetail?): Boolean {
          if (generation == token) fail("WEBVIEW_PROCESS_EXIT", "字幕页面进程已退出，请重新提取")
          return true
        }
        override fun shouldOverrideUrlLoading(view: WebView?, request: android.webkit.WebResourceRequest?): Boolean {
          val u = request?.url ?: return true
          return u.scheme != "https" || u.host !in listOf("www.youtube.com", "m.youtube.com", "consent.youtube.com", "accounts.google.com")
        }
      }
    }
    youtube = view
    host.addView(view, 0, ViewGroup.LayoutParams(-1, -1))
    val extractor = context.assets.open("android/youtube-extractor.js").bufferedReader().use { it.readText() }
    val deadline = startedAt+80000
    fun poll() {
      if (generation != token || activeId != id) return
      if (System.currentTimeMillis() > deadline) { fail("TIMEOUT", "字幕提取超时（阶段：$stage），请检查网络或更换视频重试"); return }
      val uri = Uri.parse(view.url ?: "")
      if (uri.host in listOf("consent.youtube.com", "accounts.google.com")) { fail("VERIFICATION_REQUIRED", "YouTube 要求登录或验证，后台提取无法继续。可打开 YouTube 完成验证，再导入转录稿"); return }
      if (uri.host == "www.youtube.com" && uri.getQueryParameter("v") == videoId) {
        stage = "extracting"
        val script = extractor + "\n(()=>{const player=document.querySelector('#movie_player');player?.pauseVideo?.();const ready=player?.getPlayerResponse?.()||window.ytInitialPlayerResponse;if(ready&&!window.__readerSubtitleRunning&&!window.__readerSubtitleResult){window.__readerSubtitleRunning=true;readerExtractYoutube("+JSONObject.quote(language)+").then(data=>{window.__readerSubtitleResult={data}}).catch(e=>{window.__readerSubtitleResult={error:e.message,code:e.code==='VERIFICATION_REQUIRED'?'VERIFICATION_REQUIRED':'EXTRACTION_FAILED'}})};return JSON.stringify(window.__readerSubtitleResult||null)})()"
        view.evaluateJavascript(script) { raw ->
          if (generation == token) try {
            val decoded = JSONTokener(raw).nextValue()
            if (decoded is String && decoded != "null" && decoded.length <= 2200000) {
              val value = JSONObject(decoded)
              if (value.has("error")) fail(value.optString("code", "EXTRACTION_FAILED"), value.optString("error"))
              else if (value.optJSONObject("data")?.optString("videoId") == videoId) finish(value)
            }
          } catch (_: Exception) { /* Retry while the player loads. */ }
        }
      }
      if (generation == token) { pollTask = Runnable { poll() }; handler.postDelayed(pollTask!!, 1000) }
    }
    view.loadUrl("https://www.youtube.com/watch?v=$videoId")
    pollTask = Runnable { poll() }; handler.postDelayed(pollTask!!, 1500)
  }
}

package com.example.aieducationreader.bridge

import android.annotation.SuppressLint
import android.app.Dialog
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
  private var dialog: Dialog? = null
  private var youtube: WebView? = null
  private var activeId: String? = null
  private var generation = 0
  private fun trusted(): Boolean {
    val uri = Uri.parse(reader()?.url ?: return false)
    return uri.scheme == "https" && uri.host == "appassets.androidplatform.net" && uri.path?.startsWith("/ai-education-reader/") == true
  }
  @JavascriptInterface
  fun extract(id: String, videoId: String, language: String) { handler.post {
    if (!trusted() || !id.matches(Regex("[a-zA-Z0-9-]{1,100}")) || !videoId.matches(Regex("[a-zA-Z0-9_-]{11}")) || language !in listOf("auto","zh","en","ja","ko","es")) return@post
    if (activeId != null) { emit(id, JSONObject().put("error", "已有字幕提取任务")); return@post }
    open(id, videoId, language)
  } }
  @JavascriptInterface
  fun cancel() { handler.post { finish(JSONObject().put("error", "已取消")) } }
  fun shutdown() { handler.post { finish(JSONObject().put("error", "已关闭")) } }
  private fun emit(id: String, value: JSONObject) {
    if (!trusted()) return
    value.put("channel", "reader-youtube-response").put("id", id)
    reader()?.evaluateJavascript("window.postMessage(${value},location.origin)", null)
  }
  private fun finish(value: JSONObject) {
    val id = activeId ?: return
    activeId = null; generation++
    dialog?.setOnDismissListener(null); dialog?.dismiss(); dialog = null
    youtube?.stopLoading(); youtube?.destroy(); youtube = null
    emit(id, value)
  }
  @SuppressLint("SetJavaScriptEnabled")
  private fun open(id: String, videoId: String, language: String) {
    activeId = id; val token = ++generation
    val container = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    val hint = TextView(context).apply { text = "正在读取字幕。若出现验证，请在此完成；成功后自动返回。"; setPadding(24,24,24,24) }
    container.addView(hint)
    val view = WebView(context).apply {
      settings.javaScriptEnabled = true
      settings.domStorageEnabled = true
      settings.allowFileAccess = false
      settings.allowContentAccess = false
      settings.userAgentString = settings.userAgentString.replace(Regex("\\([^)]*\\)"), "(X11; Linux x86_64)").replace("Version/4.0 ", "").replace(" Mobile", "")
      webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView?, request: android.webkit.WebResourceRequest?): Boolean {
          val u = request?.url ?: return true
          return u.scheme != "https" || u.host !in listOf("www.youtube.com", "m.youtube.com", "consent.youtube.com", "accounts.google.com")
        }
      }
    }
    youtube = view
    container.addView(view, LinearLayout.LayoutParams(-1,0,1f))
    dialog = Dialog(context).apply { setContentView(container); setOnDismissListener { finish(JSONObject().put("error","已取消")) }; show(); window?.setLayout(-1,-1) }
    val extractor = context.assets.open("android/youtube-extractor.js").bufferedReader().use { it.readText() }
    val deadline = System.currentTimeMillis()+80000
    fun poll() {
      if (generation != token || activeId != id) return
      if (System.currentTimeMillis() > deadline) { finish(JSONObject().put("error","读取字幕超时，请确认视频有字幕并重试。")); return }
      val uri = Uri.parse(view.url ?: "")
      if (uri.host == "www.youtube.com" && uri.getQueryParameter("v") == videoId) {
        val script = extractor + "\nif(!window.__readerSubtitleRunning&&!window.__readerSubtitleResult){window.__readerSubtitleRunning=true;readerExtractYoutube("+JSONObject.quote(language)+").then(data=>{window.__readerSubtitleResult={data}}).catch(e=>{window.__readerSubtitleError=e.message}).finally(()=>{window.__readerSubtitleRunning=false})};JSON.stringify(window.__readerSubtitleResult||null)"
        view.evaluateJavascript(script) { raw ->
          if (generation == token) try {
            val decoded = JSONTokener(raw).nextValue()
            if (decoded is String && decoded != "null" && decoded.length <= 2200000) {
              val value = JSONObject(decoded)
              if (value.optJSONObject("data")?.optString("videoId") == videoId) finish(value)
            }
          } catch (_: Exception) { /* Retry while the player loads. */ }
        }
      }
      handler.postDelayed({ poll() }, 2500)
    }
    view.loadUrl("https://www.youtube.com/watch?v=$videoId")
    handler.postDelayed({ poll() }, 3000)
  }
}

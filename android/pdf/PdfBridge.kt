package com.example.aieducationreader.bridge

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebResourceResponse
import android.webkit.WebView
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.roundToInt

/** Uses only API 21 PDF APIs. Work and bitmap encoding never run on the UI thread. */
class PdfBridge(context: Context, private val reader: () -> WebView?) {
  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor()
  private val directory = File(context.cacheDir, "pdf-native-${UUID.randomUUID()}").apply { mkdirs() }
  private val cache = File(context.cacheDir, "pdf-images-v1").apply { mkdirs() }
  init {
    // Recover temporary sources left behind by a killed process. Keep fresh/active hosts.
    worker.execute {
      context.cacheDir.listFiles()?.filter { it != directory && it.isDirectory && it.name.matches(Regex("pdf-native-[a-f0-9-]{36}")) && System.currentTimeMillis() - it.lastModified() > 86400000L }?.forEach { it.deleteRecursively() }
    }
  }
  private data class Session(val renderer: PdfRenderer, val hash: String)
  private val sessions = LinkedHashMap<String, Session>()
  private val cancelled = ConcurrentHashMap.newKeySet<String>()
  private val pending = ConcurrentHashMap.newKeySet<String>()
  @Volatile private var closed = false
  private fun trusted(): Boolean {
    val uri = Uri.parse(reader()?.url ?: return false)
    return uri.scheme == "https" && uri.host == "appassets.androidplatform.net" && uri.path?.startsWith("/ai-education-reader/") == true
  }
  @JavascriptInterface fun cancel(id: String) { if (pending.contains(id)) cancelled.add(id) }
  @JavascriptInterface fun request(id: String, payload: String) { main.post {
    if (closed || !trusted() || !id.matches(Regex("[a-zA-Z0-9-]{1,100}")) || payload.length > 150000) return@post
    if (pending.size >= 64) { emit(id, JSONObject().put("error", "PDF_BUSY")); return@post }
    pending.add(id)
    worker.execute {
      try {
        if (closed || cancelled.contains(id)) return@execute
        val input = JSONObject(payload)
        val doc = input.getString("doc")
        require(doc.matches(Regex("[a-zA-Z0-9-]{1,100}")))
        val file = File(directory, "$doc.pdf")
        val result = when (input.getString("op")) {
          "begin" -> { file.writeBytes(byteArrayOf()); JSONObject() }
          "append" -> {
            check(file.exists() && file.length() < 128L * 1024 * 1024)
            file.appendBytes(Base64.decode(input.getString("data"), Base64.NO_WRAP)); JSONObject()
          }
          "open" -> {
            sessions.remove(doc)?.renderer?.close()
            while (sessions.size >= 4) { val key = sessions.keys.first(); sessions.remove(key)?.renderer?.close(); File(directory, "$key.pdf").delete() }
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { stream -> val bytes = ByteArray(65536); while (true) { val n = stream.read(bytes); if (n < 0) break; digest.update(bytes, 0, n) } }
            val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
            val renderer = try { PdfRenderer(descriptor) } catch (error: Exception) { descriptor.close(); throw error }
            sessions[doc] = Session(renderer, digest.digest().joinToString("") { "%02x".format(it) })
            JSONObject().put("pages", renderer.pageCount)
          }
          "close" -> { sessions.remove(doc)?.renderer?.close(); file.delete(); JSONObject() }
          "render" -> {
            val session = sessions[doc] ?: error("PDF_SESSION_CLOSED")
            val pageIndex = input.getInt("page") - 1
            require(pageIndex in 0 until session.renderer.pageCount)
            val edge = input.optInt("edge", 1280).coerceIn(64, 1800)
            session.renderer.openPage(pageIndex).use { page ->
              val scale = minOf(3.0, edge.toDouble() / max(page.width, page.height))
              val width = max(1, (page.width * scale).roundToInt())
              val height = max(1, (page.height * scale).roundToInt())
              val output = File(cache, "${session.hash}-$pageIndex-$edge.jpg")
              if (!output.exists()) {
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                try {
                  bitmap.eraseColor(Color.WHITE)
                  page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                  if (closed || cancelled.contains(id)) return@execute
                  val temp = File(directory, "$id.jpg")
                  temp.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.JPEG, 88, it)) }
                  check(temp.renameTo(output))
                } finally { bitmap.recycle() }
              }
              output.setLastModified(System.currentTimeMillis())
              trimCache(output)
              JSONObject().put("url", "/native-pdf/${output.name}").put("width", width).put("height", height)
            }
          }
          else -> error("PDF_OPERATION_UNKNOWN")
        }
        if (!closed && !cancelled.contains(id)) main.post { if (!closed) emit(id, result) }
      } catch (error: Exception) {
        Log.w("ReaderPdf", "request=$id ${error.javaClass.simpleName}: ${error.message}")
        if (!closed && !cancelled.contains(id)) main.post { emit(id, JSONObject().put("error", "PDF_NATIVE_FAILED: ${error.javaClass.simpleName}")) }
      } catch (_: OutOfMemoryError) {
        main.post { emit(id, JSONObject().put("error", "PDF_MEMORY_LIMIT")) }
      } finally { pending.remove(id); cancelled.remove(id) }
    }
  } }
  private fun emit(id: String, result: JSONObject) {
    if (closed || !trusted()) return
    result.put("id", id).put("channel", "reader-pdf-response")
    reader()?.evaluateJavascript("window.postMessage($result,location.origin)", null)
  }
  private fun trimCache(keep: File) {
    val files = cache.listFiles()?.sortedByDescending { it.lastModified() } ?: return
    var size = 0L
    for (file in files) { size += file.length(); if (file != keep && (size > 64L * 1024 * 1024 || System.currentTimeMillis() - file.lastModified() > 7L * 86400000)) file.delete() }
  }
  fun intercept(uri: Uri): WebResourceResponse? {
    if (uri.scheme != "https" || uri.host != "appassets.androidplatform.net" || !uri.path.orEmpty().startsWith("/native-pdf/")) return null
    val name = uri.lastPathSegment.orEmpty()
    return try {
      require(name.matches(Regex("[a-f0-9]{64}-[0-9]+-[0-9]+\\.jpg")))
      WebResourceResponse("image/jpeg", null, File(cache, name).inputStream())
    } catch (_: Exception) { WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), "PDF image unavailable".byteInputStream()) }
  }
  fun shutdown() {
    if (closed) return
    closed = true
    worker.execute { sessions.values.forEach { try { it.renderer.close() } catch (_: Exception) {} }; sessions.clear(); directory.deleteRecursively() }
    worker.shutdown()
  }
}

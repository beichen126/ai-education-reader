package com.example.aieducationreader.bridge

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.CancellationException

/** Small caption-only HTTP path. No player execution, media download or external runtime. */
class NativeYoutube {
  @Volatile private var stopped = false
  @Volatile private var connection: HttpURLConnection? = null
  private var deadline = 0L
  fun cancel() { stopped = true; connection?.disconnect() }
  private fun checkActive() { if (stopped || Thread.currentThread().isInterrupted) throw CancellationException(); if (System.currentTimeMillis() >= deadline) error("NATIVE_TIMEOUT") }
  fun extract(videoId: String, language: String): JSONObject {
    require(videoId.matches(Regex("[a-zA-Z0-9_-]{11}")))
    deadline = System.currentTimeMillis() + 16000
    val html = get("https://www.youtube.com/watch?v=$videoId&hl=en", 6 * 1024 * 1024)
    checkActive()
    val player = playerResponse(html) ?: error("NATIVE_PLAYER_UNAVAILABLE")
    check(player.optJSONObject("videoDetails")?.optString("videoId") == videoId) { "NATIVE_VIDEO_MISMATCH" }
    val tracks = player.optJSONObject("captions")?.optJSONObject("playerCaptionsTracklistRenderer")?.optJSONArray("captionTracks") ?: error("NATIVE_CAPTIONS_UNAVAILABLE")
    val track = selectTrack(tracks, language) ?: error("NATIVE_LANGUAGE_UNAVAILABLE")
    val base = URI(track.getString("baseUrl"))
    require(base.scheme == "https" && base.host in listOf("www.youtube.com", "youtube.com") && base.path == "/api/timedtext") { "NATIVE_CAPTION_URL_INVALID" }
    val url = base.toASCIIString().replace(Regex("([?&])fmt=[^&]*"), "$1fmt=json3").let { if (Regex("[?&]fmt=").containsMatchIn(it)) it else it + (if (it.contains('?')) "&" else "?") + "fmt=json3" }
    val caption = JSONObject(get(url, 3 * 1024 * 1024))
    val segments = parseSegments(caption)
    check(segments.length() > 0) { "NATIVE_CAPTIONS_EMPTY" }
    return JSONObject().put("videoId", videoId).put("title", player.getJSONObject("videoDetails").optString("title").take(300))
      .put("language", track.optString("languageCode", "unknown")).put("automatic", track.optString("kind") == "asr")
      .put("segments", segments).put("fetchedAt", System.currentTimeMillis())
  }
  private fun get(url: String, limit: Int): String {
    checkActive()
    val conn = URL(url).openConnection() as HttpURLConnection
    connection = conn
    try {
      checkActive()
      val remaining = (deadline - System.currentTimeMillis()).coerceIn(1, 6000).toInt()
      conn.connectTimeout = remaining; conn.readTimeout = remaining; conn.instanceFollowRedirects = false
      conn.setRequestProperty("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
      conn.setRequestProperty("Accept-Language", "en-US,en;q=0.9")
      check(conn.responseCode == 200) { "NATIVE_HTTP_${conn.responseCode}" }
      return conn.inputStream.use { input ->
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(16384)
        while (true) { checkActive(); val n = input.read(buffer); if (n < 0) break; check(out.size() + n <= limit) { "NATIVE_RESPONSE_TOO_LARGE" }; out.write(buffer, 0, n) }
        out.toString("UTF-8")
      }
    } finally { conn.disconnect(); connection = null }
  }
  companion object {
    fun playerResponse(html: String): JSONObject? {
      val marker = Regex("(?:var\\s+)?ytInitialPlayerResponse\\s*=\\s*|window\\[\"ytInitialPlayerResponse\"\\]\\s*=\\s*")
      for (match in marker.findAll(html)) {
        val start = html.indexOf('{', match.range.last + 1)
        if (start < 0 || start - match.range.last > 20) continue
        var depth = 0; var quoted = false; var escaped = false
        for (i in start until html.length) {
          val c = html[i]
          if (quoted) { if (escaped) escaped = false else if (c == '\\') escaped = true else if (c == '"') quoted = false }
          else if (c == '"') quoted = true else if (c == '{') depth++ else if (c == '}') {
            depth--; if (depth == 0) { try { return JSONObject(html.substring(start, i + 1)) } catch (_: Exception) { break } }
          }
        }
      }
      return null
    }
    fun selectTrack(tracks: JSONArray, language: String): JSONObject? {
      return (0 until tracks.length()).mapNotNull { tracks.optJSONObject(it) }.filter {
        language == "auto" || it.optString("languageCode") == language || it.optString("languageCode").startsWith("$language-")
      }.minByOrNull { if (it.optString("kind") == "asr") 1 else 0 }
    }
    fun parseSegments(caption: JSONObject): JSONArray {
      val events = caption.optJSONArray("events") ?: return JSONArray()
      val result = JSONArray(); var length = 0
      for (i in 0 until events.length()) {
        val event = events.optJSONObject(i) ?: continue
        val parts = event.optJSONArray("segs") ?: continue
        val text = (0 until parts.length()).joinToString("") { parts.optJSONObject(it)?.optString("utf8").orEmpty() }.replace(Regex("\\s+"), " ").trim()
        val start = event.optDouble("tStartMs", -1.0) / 1000
        val duration = event.optDouble("dDurationMs", 0.0) / 1000
        if (text.isEmpty() || !start.isFinite() || start < 0 || !duration.isFinite()) continue
        if (result.length() > 0 && result.getJSONObject(result.length() - 1).optString("text") == text) continue
        length += text.length
        check(length <= 1500000 && result.length() < 20000) { "NATIVE_TRANSCRIPT_TOO_LARGE" }
        result.put(JSONObject().put("start", start).put("duration", duration.coerceAtLeast(0.0)).put("text", text))
      }
      return result
    }
  }
}

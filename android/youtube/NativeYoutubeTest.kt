package com.example.aieducationreader.bridge

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativeYoutubeTest {
  @Test fun balancedPlayerJsonHandlesBracesAndEscapes() {
    val json = JSONObject().put("videoDetails", JSONObject().put("videoId", "abcdefghijk").put("title", "a } { \"quote\" \\ end"))
    val player = NativeYoutube.playerResponse("<script>var ytInitialPlayerResponse = $json; other()</script>")!!
    assertEquals("abcdefghijk", player.getJSONObject("videoDetails").getString("videoId"))
    assertEquals(json.toString(), player.toString())
    assertNull(NativeYoutube.playerResponse("ytInitialPlayerResponse = {broken"))
  }
  @Test fun selectsRequestedVideoAfterUnrelatedPlayer() {
    val html = """var ytInitialPlayerResponse = {"videoDetails":{"videoId":"other"}}; var ytInitialPlayerResponse = {"videoDetails":{"videoId":"ivfw_TcsHbw"}};"""
    assertEquals("ivfw_TcsHbw", NativeYoutube.playerResponse(html, "ivfw_TcsHbw")!!.getJSONObject("videoDetails").getString("videoId"))
    assertNull(NativeYoutube.playerResponse(html, "absent"))
  }
  @Test fun languageAndManualTrackSelection() {
    val tracks = JSONArray("""[{"languageCode":"en","kind":"asr"},{"languageCode":"zh-Hans"},{"languageCode":"en"}]""")
    assertEquals("en", NativeYoutube.selectTrack(tracks, "en")!!.getString("languageCode"))
    assertEquals("", NativeYoutube.selectTrack(tracks, "en")!!.optString("kind"))
    assertEquals("zh-Hans", NativeYoutube.selectTrack(tracks, "zh")!!.getString("languageCode"))
    assertNull(NativeYoutube.selectTrack(tracks, "ja"))
  }
  @Test fun segmentsRejectInvalidTimesAndDeduplicate() {
    val json = JSONObject("""{"events":[{"tStartMs":1000,"dDurationMs":2000,"segs":[{"utf8":"hello "},{"utf8":"world"}]},{"tStartMs":1500,"segs":[{"utf8":"hello world"}]},{"tStartMs":-1,"segs":[{"utf8":"bad"}]},{"tStartMs":3000,"segs":[{"utf8":"next"}]}]}""")
    val segments = NativeYoutube.parseSegments(json)
    assertEquals(2, segments.length())
    assertEquals(1.0, segments.getJSONObject(0).getDouble("start"), 0.001)
    assertEquals(2.0, segments.getJSONObject(0).getDouble("duration"), 0.001)
    assertEquals("hello world", segments.getJSONObject(0).getString("text"))
  }
  @Test fun cancellationPreventsNetworkStart() {
    val request = NativeYoutube(); request.cancel()
    try { request.extract("abcdefghijk", "en"); fail("should cancel") } catch (_: java.util.concurrent.CancellationException) {}
  }
}

import assert from 'node:assert/strict'
import {youtubeVideoId,validTranscript,transcriptContext} from '../src/youtube/transcript.ts'
assert.equal(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=12'),'dQw4w9WgXcQ')
assert.equal(youtubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'),'dQw4w9WgXcQ')
for(const url of ['javascript:alert(1)','https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ','https://youtube.com/playlist?list=x'])assert.throws(()=>youtubeVideoId(url))
const data={videoId:'dQw4w9WgXcQ',title:'Lesson',language:'en',segments:[{start:61,duration:3,text:'Example caption'}],fetchedAt:1}
assert.ok(validTranscript(data));assert.ok(!validTranscript({...data,segments:[]}));assert.ok(!validTranscript({...data,segments:[{start:-1,text:'bad',duration:1}]}));assert.match(transcriptContext(data),/01:01/)
console.log('PASS YouTube URL validation, transcript bounds and timestamp context')

// Execute the exact polling expression shipped in the Android bridge repeatedly.
const { readFileSync } = await import('node:fs')
const { createContext, runInContext } = await import('node:vm')
const bridge = readFileSync('android/youtube/YoutubeBridge.kt','utf8')
const expression = bridge.match(/val script = extractor \+ (.+)/)![1]
const parts = expression.split('+JSONObject.quote(language)+')
const pollScript = JSON.parse(parts[0]) + JSON.stringify('auto') + JSON.parse(parts[1])
for (const failure of [false,true]) {
 let attempts=0
 const scope:any={document:{querySelector:()=>({getPlayerResponse:()=>({videoDetails:{videoId:'abcdefghijk'}}),pauseVideo(){}})},readerExtractYoutube:async()=>{attempts++;if(failure)throw new Error('no captions');return {videoId:'abcdefghijk'}}}
 scope.window=scope
 const context=createContext(scope)
 runInContext(pollScript,context)
 await new Promise(resolve=>setTimeout(resolve,0))
 const result=JSON.parse(runInContext(pollScript,context))
 assert.equal(attempts,1)
 assert.equal(failure?result.code:result.data.videoId,failure?'EXTRACTION_FAILED':'abcdefghijk')
 runInContext(pollScript,context)
 assert.equal(attempts,1)
}
console.log('PASS exact Android poll script: repeated evaluation, success/error delivery and no repeated extraction')

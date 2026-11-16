import assert from 'node:assert/strict'
import {youtubeVideoId,validTranscript,transcriptContext} from '../src/youtube/transcript.ts'
assert.equal(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=12'),'dQw4w9WgXcQ')
assert.equal(youtubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'),'dQw4w9WgXcQ')
for(const url of ['javascript:alert(1)','https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ','https://youtube.com/playlist?list=x'])assert.throws(()=>youtubeVideoId(url))
const data={videoId:'dQw4w9WgXcQ',title:'Lesson',language:'en',segments:[{start:61,duration:3,text:'Example caption'}],fetchedAt:1}
assert.ok(validTranscript(data));assert.ok(!validTranscript({...data,segments:[]}));assert.ok(!validTranscript({...data,segments:[{start:-1,text:'bad',duration:1}]}));assert.match(transcriptContext(data),/01:01/)
console.log('PASS YouTube URL validation, transcript bounds and timestamp context')

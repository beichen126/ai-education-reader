import { getSettingsSnapshot } from '../engine/settings-store'
import { ttsEndpoint } from './read-aloud'
export function pcmWav(samples: Float32Array, rate=16000): Blob {
  const buffer=new ArrayBuffer(44+samples.length*2), view=new DataView(buffer)
  const write=(offset:number,text:string)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i))}
  write(0,'RIFF');view.setUint32(4,36+samples.length*2,true);write(8,'WAVE');write(12,'fmt ')
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,samples.length*2,true)
  samples.forEach((value,i)=>view.setInt16(44+i*2,Math.max(-1,Math.min(1,value))*(value<0?32768:32767),true))
  return new Blob([buffer],{type:'audio/wav'})
}
export async function transcribeAudio(blob: Blob, signal: AbortSignal): Promise<string> {
  const settings=getSettingsSnapshot(),key=settings.apiKey
  if(!key)throw new Error('请先在通用设置填写 DeepSeek 语音 API Key。')
  if(blob.size>8*1024*1024)throw new Error('音频文件不能超过 8 MiB。')
  const context=new AudioContext()
  let decoded:AudioBuffer
  try {decoded=await context.decodeAudioData(await blob.arrayBuffer())}finally{await context.close()}
  if(decoded.duration>120)throw new Error('音频不能超过 120 秒。')
  if(signal.aborted)throw new DOMException('Aborted','AbortError')
  const offline=new OfflineAudioContext(1,Math.max(1,Math.ceil(decoded.duration*16000)),16000)
  const source=offline.createBufferSource();source.buffer=decoded;source.connect(offline.destination);source.start()
  const rendered=await offline.startRendering()
  const form=new FormData();form.append('file',pcmWav(rendered.getChannelData(0)),'speech.wav')
  const endpoint=ttsEndpoint('https://api.deepseek.com').replace(/\/tts$/,'/asr')
  const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+key},body:form,signal})
  if(!response.ok)throw new Error('DeepSeek 语音识别失败（HTTP '+response.status+'）')
  const result=await response.json()
  if(typeof result.text!=='string'||!result.text.trim())throw new Error('未识别到文字，请重试。')
  return result.text.trim()
}

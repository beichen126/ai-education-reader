import { isOfficialDeepSeek, DeepSeekFilesError } from './deepseek-files'
export type DeepSeekDocument = { id:string; name:string; size:number; purpose:'user_data'|'text_recognition'|'rich_layout_recognition'; expiresAt:number }
export const DOCUMENT_ACCEPT='.pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.csv,.json,.xlsx,.xls,.epub,.mobi'
export function documentPurpose(name:string,rich:boolean):DeepSeekDocument['purpose'] {return /\.(pdf|docx?|pptx?)$/i.test(name)?rich?'rich_layout_recognition':'text_recognition':'user_data'}
export async function uploadDeepSeekDocument(file:File,options:{baseUrl:string;apiKey:string;rich:boolean;signal:AbortSignal}):Promise<DeepSeekDocument>{
 if(!isOfficialDeepSeek(options.baseUrl))throw new DeepSeekFilesError('文件解析需要 DeepSeek 官方 API 地址。')
 if(!options.apiKey)throw new DeepSeekFilesError('请配置 DeepSeek API Key。')
 if(!DOCUMENT_ACCEPT.split(',').some(ext=>file.name.toLowerCase().endsWith(ext)))throw new DeepSeekFilesError('不支持此文件格式。')
 const purpose=documentPurpose(file.name,options.rich),limit=(purpose==='user_data'?32:100)*1024*1024
 if(file.size>limit)throw new DeepSeekFilesError('文件超过 '+limit/1024/1024+' MiB 上限。')
 const form=new FormData();form.append('purpose',purpose);form.append('expires_after[anchor]','created_at');form.append('expires_after[seconds]','2592000');form.append('file',file)
 const controller=new AbortController(),cancel=()=>controller.abort()
 options.signal.addEventListener('abort',cancel,{once:true});if(options.signal.aborted)cancel()
 const timer=setTimeout(cancel,300000)
 let response:Response
 try {response=await fetch('https://api.deepseek.com/files',{method:'POST',headers:{Authorization:'Bearer '+options.apiKey},body:form,signal:controller.signal})} finally {clearTimeout(timer);options.signal.removeEventListener('abort',cancel)}
 if(!response.ok)throw new DeepSeekFilesError('上传解析失败（HTTP '+response.status+'）')
 const data=await response.json()
 if(typeof data.id!=='string'||!/^file-api-[\w-]+$/.test(data.id))throw new DeepSeekFilesError('服务器未返回有效文件编号。')
 return {id:data.id,name:file.name,size:file.size,purpose,expiresAt:(data.expires_at || Date.now()/1000+2592000)*1000}
}
export function validateDocumentContext(documents:DeepSeekDocument[],baseUrl:string,model:string){
 if(!documents.length)return
 if(!isOfficialDeepSeek(baseUrl)||model!=='deepseek-flash')throw new DeepSeekFilesError('文档上下文需要 DeepSeek 官方 API 与 deepseek-flash 模型；请切回该服务或新建无文件会话。')
 if(documents.length>20)throw new DeepSeekFilesError('本次上下文超过 20 份文档，请新建会话或减少文件。')
 if(documents.some(d=>!/^file-api-[\w-]+$/.test(d.id)||!Number.isFinite(d.expiresAt)||d.expiresAt<=Date.now()))throw new DeepSeekFilesError('文件引用无效或已过期，请重新上传并开始新会话。')
}

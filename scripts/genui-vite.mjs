import {readFileSync,readdirSync} from 'node:fs'
import path from 'node:path'
const root=path.resolve('node_modules/@changfenhuang/dsh-genui')
export const genuiAliases={
 'reader-genui-embed':path.join(root,'src/client/embed.ts'),
 'reader-genui-partial':path.join(root,'src/client/parse-partial.ts'),
 'reader-genui-templates':path.join(root,'src/client/templates.ts'),
 'reader-genui-locale':path.join(root,'src/client/i18n/runtime.ts'),
}
export function genuiAssetsPlugin(){
 const dir=path.join(root,'lib/assets'),prefix='genui-assets/0.16.0/'
 return {name:'reader-genui-assets',
  generateBundle(){for(const file of ['LICENSE','THIRD_PARTY_NOTICES.md'])this.emitFile({type:'asset',fileName:prefix+file,source:readFileSync(path.join(root,file))});for(const file of readdirSync(dir).filter(f=>f.endsWith('.js')))this.emitFile({type:'asset',fileName:prefix+file,source:readFileSync(path.join(dir,file))})},
  configureServer(server){server.middlewares.use((req,res,next)=>{
   const url=(req.url||'').split('?')[0],index=url.indexOf('/'+prefix)
   if(index<0)return next()
   const file=url.slice(index+prefix.length+1)
   if(!/^[a-z-]+\.js$/.test(file)||!readdirSync(dir).includes(file))return next()
   res.setHeader('Content-Type','application/javascript');res.end(readFileSync(path.join(dir,file)))
  })}
 }
}

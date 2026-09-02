
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const root = process.argv[2]
const baseFile = process.argv[3]
const base = JSON.parse(fs.readFileSync(baseFile,'utf8'))
const baseMap = new Map(base.files.map(f=>[f.path, f]))
const cur = new Map()
function add(fp){
  try {
    const rel = fp.substring(root.length).replace(/\\/g,'/').replace(/^\//,'')
    if (cur.has(rel)) return
    cur.set(rel, true)
    const buf = fs.readFileSync(fp)
    const sha = crypto.createHash('sha256').update(buf).digest('hex')
    const st = fs.statSync(fp)
    const prev = baseMap.get(rel)
    const ok = prev && prev.sha256 === sha && prev.length === st.size
    if (!ok) report.push({ type:'changed', path:rel, expected: prev?prev.sha256:null, actual:sha })
  } catch {}
}
function walk(dir){
  for (const ent of fs.readdirSync(dir,{withFileTypes:true})){
    const p = path.join(dir, ent.name)
    if (ent.name === 'node_modules') continue
    if (ent.isDirectory()) walk(p)
    else add(p)
  }
}
const report = []
walk(root)
const scoped = path.join(root,'node_modules','@deepseek-ai')
if (fs.existsSync(scoped)){
  for (const pkg of fs.readdirSync(scoped)){
    const pkgPath = path.join(scoped,pkg)
    if (!fs.statSync(pkgPath).isDirectory()) continue
    for (const ent of fs.readdirSync(pkgPath,{withFileTypes:true})){
      const p = path.join(pkgPath, ent.name)
      if (ent.isDirectory()) walk(p)
    }
  }
}
const removed = base.files.filter(f=>!cur.has(f.path)).map(f=>f.path)
const result = { ok: report.length===0 && removed.length===0, changedCount: report.length, removedCount: removed.length, sample: report.slice(0,20).map(r=>r.type+':'+r.path), added: [...cur.keys()].filter(k=>!baseMap.has(k)).length }
console.log(JSON.stringify(result,null,2))

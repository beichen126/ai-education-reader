
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const root = process.argv[2]
const out = process.argv[3]
const records = []
const seen = new Set()
function add(fp){
  try {
    const rel = fp.substring(root.length).replace(/\\/g,'/').replace(/^\//,'')
    if (seen.has(rel)) return
    seen.add(rel)
    const buf = fs.readFileSync(fp)
    const sha = crypto.createHash('sha256').update(buf).digest('hex')
    const st = fs.statSync(fp)
    records.push({ path: rel, sha256: sha, length: st.size, mtime: st.mtime.toISOString() })
  } catch {}
}
function walk(dir, excludeNodeModules){
  for (const ent of fs.readdirSync(dir,{withFileTypes:true})){
    const p = path.join(dir, ent.name)
    if (excludeNodeModules && ent.name === 'node_modules') continue
    if (ent.isDirectory()) walk(p, excludeNodeModules)
    else add(p)
  }
}
// A) dsh package itself
walk(root, true)
// B) @deepseek-ai scoped packages under root/node_modules/@deepseek-ai
const scoped = path.join(root, 'node_modules','@deepseek-ai')
if (fs.existsSync(scoped)){
  for (const pkg of fs.readdirSync(scoped)){
    const pkgPath = path.join(scoped, pkg)
    if (!fs.statSync(pkgPath).isDirectory()) continue
    for (const ent of fs.readdirSync(pkgPath,{withFileTypes:true})){
      const p = path.join(pkgPath, ent.name)
      if (ent.isDirectory()) walk(p, true)
      else { /* root file */ }
    }
  }
}
const manifest = { root, generatedUtc: new Date().toISOString(), count: records.length, files: records }
fs.writeFileSync(out, JSON.stringify(manifest, null, 2))
console.log('BASELINE_DONE files=' + records.length + ' bytes=' + fs.statSync(out).size + ' out=' + out)

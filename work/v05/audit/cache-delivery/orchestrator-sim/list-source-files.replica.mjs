// Verbatim copy of listSourceFiles()/fingerprint() from scripts/verify-v05.mjs @ e2a6c73, parameterised by root, to see exactly what is fingerprinted/archived.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
const root = process.argv[2]
function listSourceFiles() {
  const include = ['packages', 'apps', 'benchmarks', 'docs', 'scripts', 'validation/README.md']
  const rootFiles = ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'README.zh-CN.md', 'LICENSE', 'CHANGELOG.md', '.gitignore', '.npmrc', 'MIGRATION_V04_TO_V05.md']
  const excludeDir = new Set(['node_modules', 'dist', 'dist-local', '.tsbuildinfo', 'work', 'coverage'])
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (excludeDir.has(entry.name) || entry.name.startsWith('.tsbuildinfo') || entry.name === '.DS_Store') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(path.relative(root, full))
    }
  }
  for (const dir of include) {
    const full = path.join(root, dir)
    if (existsSync(full) && statSync(full).isDirectory()) walk(full)
    else if (existsSync(full)) files.push(dir)
  }
  for (const file of rootFiles) if (existsSync(path.join(root, file))) files.push(file)
  const githubDir = path.join(root, '.github')
  if (existsSync(githubDir)) walk(githubDir)
  return [...new Set(files)].filter(file => !file.includes('/dist/') && !file.startsWith('validation/v0.5-dev')).sort()
}
const files = listSourceFiles()
const hash = createHash('sha256')
for (const file of files) hash.update(`${file}\n${createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')}\n`)
console.log(JSON.stringify({ count: files.length, digest: hash.digest('hex') }))
console.log(files.filter(f => /tsbuildinfo|\/dist\/|node_modules|\.log$|manifest|validation/.test(f)).join('\n') || '(no build artefacts / validation outputs in list)')
console.log('--- top-level groups ---')
const groups = {}; for (const f of files) { const g = f.split('/').slice(0, 2).join('/'); groups[g] = (groups[g] ?? 0) + 1 }
console.log(JSON.stringify(groups))

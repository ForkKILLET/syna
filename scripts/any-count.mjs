#!/usr/bin/env node
// Counts the `any` type keyword per TypeScript source file (TypeScript AST, so comments and strings do not count).
//
//   node scripts/any-count.mjs [--json <out.json>]                 print / write the per-file counts
//   node scripts/any-count.mjs --check work/v06/ANY_BASELINE.json   exit 1 if any file exceeds its baseline count
//                                                                   (a file absent from the baseline must have 0)
// Scanned: packages/*/src, packages/*/type-tests, apps/*/src (declaration files, dist and node_modules excluded).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const walk = (dir, out) => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full)
  }
  return out
}

const roots = []
for (const group of ['packages', 'apps']) {
  for (const name of readdirSync(path.join(root, group))) {
    for (const sub of ['src', 'type-tests']) {
      const dir = path.join(root, group, name, sub)
      try { if (statSync(dir).isDirectory()) roots.push(dir) } catch { /* absent */ }
    }
  }
}

export const countAny = () => {
  const counts = {}
  for (const file of roots.flatMap(dir => walk(dir, [])).sort()) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    let count = 0
    const visit = node => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) count += 1
      ts.forEachChild(node, visit)
    }
    visit(source)
    counts[path.relative(root, file)] = count
  }
  return counts
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const counts = countAny()
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  const baselineFile = option('--check')
  if (baselineFile) {
    const baseline = JSON.parse(readFileSync(path.resolve(root, baselineFile), 'utf8'))
    const violations = Object.entries(counts).filter(([file, count]) => count > (baseline.files[file] ?? 0))
    const baselineTotal = Object.values(baseline.files).reduce((sum, count) => sum + count, 0)
    console.log(`any keywords: ${total} in ${Object.keys(counts).length} files (baseline ${baselineTotal} in ${Object.keys(baseline.files).length} files)`)
    for (const [file, count] of violations) console.log(`  ${file}: ${count} > baseline ${baseline.files[file] ?? 0}`)
    console.log(violations.length === 0 ? 'ANY COUNT OK' : 'ANY COUNT EXCEEDED')
    process.exit(violations.length === 0 ? 0 : 1)
  }
  const out = option('--json')
  const document = { generatedBy: 'scripts/any-count.mjs', total, files: counts }
  if (out) { writeFileSync(path.resolve(root, out), JSON.stringify(document, null, 2) + '\n'); console.log(`wrote ${out}: ${total} any keywords in ${Object.keys(counts).length} files`) }
  else console.log(JSON.stringify(document, null, 2))
}

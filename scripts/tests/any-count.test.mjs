// A09: the number of `any` type keywords per TypeScript source file may not exceed the 0.5.0 baseline
// (scripts/any-baseline-v0.5.0.json, recorded by `node scripts/any-count.mjs --json` on 0.5.0; shipped with the
// source so the release gate can re-check it inside the rebuilt archive). Files absent from the
// baseline must not use `any` at all.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { countAny } from '../any-count.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const baseline = JSON.parse(readFileSync(path.join(root, 'scripts/any-baseline-v0.5.0.json'), 'utf8'))

test('A09 any-keyword count per file is at or below the 0.5.0 baseline', () => {
  const counts = countAny()
  const violations = Object.entries(counts).filter(([file, count]) => count > (baseline.files[file] ?? 0))
  assert.deepEqual(violations, [], `files above their baseline: ${violations.map(([file, count]) => `${file} ${count} > ${baseline.files[file] ?? 0}`).join(', ')}`)
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  assert.ok(total <= baseline.total, `total ${total} > baseline ${baseline.total}`)
})

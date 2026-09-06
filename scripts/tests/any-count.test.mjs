// A09: the number of `any` type keywords per TypeScript source file may not exceed the 0.5.0 baseline
// (work/v06/ANY_BASELINE.json, recorded by `node scripts/any-count.mjs --json`). Files absent from the
// baseline must not use `any` at all.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { countAny } from '../any-count.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const baseline = JSON.parse(readFileSync(path.join(root, 'work/v06/ANY_BASELINE.json'), 'utf8'))

test('A09 any-keyword count per file is at or below the 0.5.0 baseline', () => {
  const counts = countAny()
  const violations = Object.entries(counts).filter(([file, count]) => count > (baseline.files[file] ?? 0))
  assert.deepEqual(violations, [], `files above their baseline: ${violations.map(([file, count]) => `${file} ${count} > ${baseline.files[file] ?? 0}`).join(', ')}`)
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  assert.ok(total <= baseline.total, `total ${total} > baseline ${baseline.total}`)
})

// A09: the number of `any` type keywords per TypeScript source file may not exceed its recorded baseline. 1.0.0-rc.2
// checks against scripts/any-baseline-v1.0.0-rc.2.json — the 0.7.0 record (scripts/any-baseline-v0.7.0.json, recorded
// by `node scripts/any-count.mjs --json` on the 0.7.0 source; 0.8.0 and 1.0.0-rc.1 measured the same 178) with the
// files of the reference application re-keyed under its 1.0.0-rc.2 directory (apps/multitenant-blog, a rename:
// docs/HISTORY.md) and the deleted demos and fixtures dropped (each carried 0). Files absent from the baseline — the
// seven examples, the rebuilt fixtures — must not use `any` at all. Both files ship with the source so the release gate
// re-checks them inside the rebuilt archive; the 0.5.0 and 0.6.0 files are kept as the records of those releases.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { countAny } from '../any-count.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const baseline = JSON.parse(readFileSync(path.join(root, 'scripts/any-baseline-v1.0.0-rc.2.json'), 'utf8'))
const record = JSON.parse(readFileSync(path.join(root, 'scripts/any-baseline-v0.7.0.json'), 'utf8'))

test('A09 any-keyword count per file is at or below the 1.0.0-rc.2 baseline; files outside it use none', () => {
  const counts = countAny()
  const violations = Object.entries(counts).filter(([file, count]) => count > (baseline.files[file] ?? 0))
  assert.deepEqual(violations, [], `files above their baseline: ${violations.map(([file, count]) => `${file} ${count} > ${baseline.files[file] ?? 0}`).join(', ')}`)
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  assert.ok(total <= baseline.total, `total ${total} > baseline ${baseline.total}`)
  const outside = Object.entries(counts).filter(([file]) => !(file in baseline.files))
  assert.ok(outside.some(([file]) => file.startsWith('apps/01-basics/')) && outside.some(([file]) => file.startsWith('packages/notify-contract/')), 'the examples and the fixtures are outside the baseline')
  assert.deepEqual(outside.filter(([, count]) => count > 0), [], 'a file outside the baseline uses any')
})

test('the 1.0.0-rc.2 baseline is the 0.7.0 record re-keyed: the same counts under the application directory, the core unchanged, the dropped files carried 0, the same total', () => {
  // The record has one application with `any` keywords — the reference application under its former directory; every
  // other application and fixture package of the record is gone from this line and carried 0.
  const directoryOf = file => file.split('/').slice(0, 2).join('/')
  const totals = new Map()
  for (const [file, count] of Object.entries(record.files)) totals.set(directoryOf(file), (totals.get(directoryOf(file)) ?? 0) + count)
  const recordApps = [...totals.keys()].filter(directory => directory.startsWith('apps/'))
  const formerApp = recordApps.filter(directory => totals.get(directory) > 0)
  assert.equal(formerApp.length, 1, 'exactly one application of the 0.7.0 record used any')
  const expected = {}
  for (const [file, count] of Object.entries(record.files)) {
    const directory = directoryOf(file)
    if (directory === formerApp[0]) expected[`apps/multitenant-blog/${file.slice(directory.length + 1)}`] = count
    else if (directory === 'packages/core' || directory === 'packages/logger') expected[file] = count
    else assert.equal(count, 0, `${file} carried any keywords and is not in the baseline`)
  }
  assert.deepEqual(baseline.files, expected)
  assert.equal(baseline.total, record.total)
  assert.equal(baseline.total, Object.values(baseline.files).reduce((sum, count) => sum + count, 0))
  assert.equal(baseline.total, 178)
  assert.ok(Object.keys(baseline.files).every(file => /^(apps\/multitenant-blog|packages\/(core|logger))\//.test(file)), 'the baseline names only the application, the core and the logger fixture')
})

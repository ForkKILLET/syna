// A01 (v0.6) / A11 (v0.7): nothing in the public API is deprecated. The 23 aliases the 0.6 line carried with
// `@deprecated … Removed in 0.7.0` are gone (docs/MIGRATION_V06_TO_V07.md). A future deprecation is registered
// here — path, replacement, removal version — before it is tagged; an unregistered tag fails this test, and so
// does a registered item whose note does not name its replacement and removal version. Uses the inventory
// script's TypeScript view of packages/core/src/index.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inventory } from '../api-inventory.mjs'

/** @type {readonly { path: string, replacement: string, removal: string }[]} */
const EXPECTED = []

test('the public API carries no @deprecated item (0.7: the 0.6 aliases are removed); a registered deprecation names its replacement and removal version', () => {
  const items = new Map()
  for (const entry of inventory()) {
    items.set(entry.name, { deprecated: entry.deprecated, note: entry.note })
    for (const member of entry.members) items.set(`${entry.name}.${member.name}`, { deprecated: member.deprecated, note: member.note })
  }
  assert.ok(items.size > 100, `inventory has ${items.size} items`)
  for (const expected of EXPECTED) {
    const item = items.get(expected.path)
    assert.ok(item, `${expected.path} is not in the public API`)
    assert.equal(item.deprecated, true, `${expected.path} must be @deprecated`)
    assert.match(item.note, new RegExp(`\`${expected.replacement}(\\(\\))?\``), `${expected.path}: note must name \`${expected.replacement}\` (got: ${item.note})`)
    assert.match(item.note, new RegExp(`Removed in ${expected.removal.replaceAll('.', '\\.')}`), `${expected.path}: note must name the removal version (got: ${item.note})`)
  }
  const deprecated = [...items].filter(([, item]) => item.deprecated).map(([path]) => path).sort()
  assert.deepEqual(deprecated, EXPECTED.map(expected => expected.path).sort(), 'deprecated items outside the register')
  assert.equal(deprecated.length, 0, 'v0.7 ships with no deprecated item')
})

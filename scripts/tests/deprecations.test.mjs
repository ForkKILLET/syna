// A01 / Phase B: every 0.5 name kept as an alias carries a `@deprecated` tag that names its replacement and the
// removal version 0.7.0, and nothing else in the public API is deprecated. Uses the inventory script's TypeScript
// view of packages/core/src/index.ts. Each rename commit adds its aliases here; each deletion commit removes them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inventory } from '../api-inventory.mjs'

const EXPECTED = [
  // R1 scope → reuse
  { path: 'DeriveOptions', replacement: 'ReuseConstraints' },
  { path: 'ScopeTarget', replacement: 'ReuseTarget' },
  { path: 'EntryDescriptor.scope', replacement: 'reuse' },
  { path: 'EntryDefinition.scope', replacement: 'reuse' },
  // R2 bind → anchor
  { path: 'EnvHandle.bind', replacement: 'anchor' },
  { path: 'BoundEntry', replacement: 'AnchoredEntry' },
  // R3 SynaRuntime → Runtime
  { path: 'SynaRuntime', replacement: 'Runtime' },
  // R4 DependencyRef → ServiceRef (the old name is the union alias for one minor)
  { path: 'DependencyRef', replacement: 'ServiceRef' },
  // R5 PersistentImplementationRef → ImplementationRef; implementationId → familyId
  { path: 'PersistentImplementationRef', replacement: 'ImplementationRef' },
  { path: 'ImplementationRef.implementationId', replacement: 'familyId' },
  // R6 RuntimePolicyContext.site → dependencySite
  { path: 'RuntimePolicyContext.site', replacement: 'dependencySite' },
]

test('every deprecated alias names its replacement and the 0.7.0 removal; nothing else is deprecated', () => {
  const items = new Map()
  for (const entry of inventory()) {
    items.set(entry.name, { deprecated: entry.deprecated, note: entry.note })
    for (const member of entry.members) items.set(`${entry.name}.${member.name}`, { deprecated: member.deprecated, note: member.note })
  }
  for (const expected of EXPECTED) {
    const item = items.get(expected.path)
    assert.ok(item, `${expected.path} is not in the public API`)
    assert.equal(item.deprecated, true, `${expected.path} must be @deprecated`)
    if (expected.legacy) continue
    assert.match(item.note, new RegExp(`\`${expected.replacement}(\\(\\))?\``), `${expected.path}: note must name \`${expected.replacement}\` (got: ${item.note})`)
    assert.match(item.note, /Removed in 0\.7\.0/, `${expected.path}: note must name the removal version (got: ${item.note})`)
  }
  const unexpected = [...items].filter(([path, item]) => item.deprecated && !EXPECTED.some(expected => expected.path === path)).map(([path]) => path)
  assert.deepEqual(unexpected, [], 'deprecated items outside the expected list')
})

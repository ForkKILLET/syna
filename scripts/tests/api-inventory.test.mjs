// A01 / A07: the public API of this source, as `scripts/api-inventory.mjs` records it. No deleted (D) name and
// no un-exported (M2) helper survives; every new name is present; every deprecated item names its 0.7.0 removal.
// When the 0.5.0 record and the committed AFTER inventory are present (source repository, not the archive), the
// diff against the record contains only the expected removals and additions and the committed AFTER is current.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function currentInventory() {
  const dir = mkdtempSync(path.join(tmpdir(), 'syna-inventory-'))
  try {
    const file = path.join(dir, 'after.json')
    execFileSync(process.execPath, ['scripts/api-inventory.mjs', '--json', file], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    return JSON.parse(readFileSync(file, 'utf8'))
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const after = currentInventory()
const paths = new Set(after.items.map(item => item.path))

const DELETED = [
  'serviceRange', 'ImplementationSelector', 'ImplementationSelectorDependency', 'ImplementationLease',
  'EntryParameter', 'EntryParameterMap', 'EntryParameterValue', 'EntryParameterValues', 'EntryRunArguments',
  'DependencyOutput', 'NormalizedServiceFailurePolicy', 'SetupResult',
]
const DELETED_MEMBERS = ['Contract.selector', 'DependencyRef.preload', 'ServiceRef.preload', 'InputRef.load', "InspectionNodeKind['selector']", "SynaErrorCode['UNAVAILABLE_IMPLEMENTATION']", "SynaErrorCode['CONSTRAINT_VIOLATION']", "DiagnosticCode['UNAVAILABLE_IMPLEMENTATION']", "DiagnosticCode['CONSTRAINT_VIOLATION']"]
const NEW = [
  'Runtime', 'AnchoredEntry', 'ServiceRef', 'InputRef', 'ImplementationRef', 'ReuseConstraints', 'ReuseTarget', 'EntryOptions', 'RuntimeLimits',
  'EntryParameters', 'EntryArguments', 'LoadedDependencies', 'SynaError', 'SynaErrorOf', 'SynaErrorConstructor', 'SynaErrorDetails', 'SynaErrorCode', 'DiagnosticCode', 'isSynaError',
  'EnvHandle.anchor', 'EntryDescriptor.reuse', 'RuntimePolicyContext.dependencySite', 'ImplementationRef.familyId', 'CreateRuntimeOptions.limits',
  'RuntimeLimits.setupDeadlineMs', 'RuntimeLimits.disposalGraceMs', 'RuntimeLimits.planningBudget', 'RuntimeLimits.planCacheEntries',
  "SynaErrorCode['FRESH_CONSTRAINT_FAILED']", "SynaErrorCode['SHARE_CONSTRAINT_FAILED']", "DiagnosticCode['UNKNOWN_ERROR']",
]

test('A01 no deleted name survives and every new name is exported', () => {
  const survivors = after.items.filter(item => DELETED.some(name => item.path === name || item.path.startsWith(`${name}.`) || item.path.startsWith(`${name}[`)) || DELETED_MEMBERS.includes(item.path)).map(item => item.path)
  assert.deepEqual(survivors, [], 'deleted names still in the public API')
  const missing = NEW.filter(name => !paths.has(name))
  assert.deepEqual(missing, [], 'new names missing from the public API')
  assert.equal(after.version, JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version)
})

test('A01 every deprecated item names its removal version; the error-code union has 22 members', () => {
  const deprecated = after.items.filter(item => item.deprecated)
  assert.ok(deprecated.length >= 23, `expected the 23 aliases of the migration table, found ${deprecated.length}`)
  for (const item of deprecated) assert.match(item.note, /Removed in 0\.7\.0/, `${item.path}: ${item.note}`)
  const codes = after.items.filter(item => /^SynaErrorCode\['/.test(item.path)).map(item => item.path.slice("SynaErrorCode['".length, -2))
  assert.equal(codes.length, 22, codes.join(','))
  assert.ok(!codes.includes('CONSTRAINT_VIOLATION') && !codes.includes('UNAVAILABLE_IMPLEMENTATION') && codes.includes('FRESH_CONSTRAINT_FAILED'))
})

const before = path.join(root, 'work/v06/API_INVENTORY_BEFORE.json')
test('A01 the diff against the 0.5.0 record contains only the expected removals and additions', { skip: existsSync(before) ? false : 'work/v06/API_INVENTORY_BEFORE.json is not part of this tree' }, () => {
  const record = JSON.parse(readFileSync(before, 'utf8'))
  const beforePaths = new Set(record.items.map(item => item.path))
  const removed = [...beforePaths].filter(item => !paths.has(item))
  const added = [...paths].filter(item => !beforePaths.has(item))
  const removable = item => DELETED.some(name => item === name || item.startsWith(`${name}.`) || item.startsWith(`${name}[`)) || DELETED_MEMBERS.includes(item)
    // R1–R5/T1: members moved from the old interface name to the new one (the old name is a type alias without members of its own).
    || /^(DependencyRef|PersistentImplementationRef|SynaError|BoundEntry|DeriveOptions|ScopeTarget|SynaRuntime)\./.test(item)
    // T2: the five phantom fields are one `__type`.
    || /\.__(api|value|publicApi|contract)$/.test(item)
  const unexpectedRemovals = removed.filter(item => !removable(item))
  assert.deepEqual(unexpectedRemovals, [], 'removed from the public API without being on the deletion list')
  const addable = item => NEW.includes(item)
    || /^(Runtime|AnchoredEntry|ServiceRef|ImplementationRef|ReuseConstraints|ReuseTarget|EntryOptions|RuntimeLimits|EntryArguments|SynaErrorOf|SynaErrorDetails|SynaErrorConstructor|PlanCacheOptions|InitializationOptions|DisposalOptions|PlanningOptions)(\.|\[|$)/.test(item)
    // R1/R6/T2: new members on kept interfaces, the unified phantom field.
    || /^(EntryDefinition|EntryDescriptor)\.reuse$/.test(item) || /\.__type$/.test(item)
  const unexpectedAdditions = added.filter(item => !addable(item))
  assert.deepEqual(unexpectedAdditions, [], 'added to the public API outside the rename list')
  assert.ok(removed.includes("SynaErrorCode['CONSTRAINT_VIOLATION']") && added.includes("SynaErrorCode['FRESH_CONSTRAINT_FAILED']"))
  const committedAfter = path.join(root, 'work/v06/API_INVENTORY_AFTER.json')
  if (existsSync(committedAfter)) {
    const committed = JSON.parse(readFileSync(committedAfter, 'utf8'))
    assert.deepEqual(committed.items, after.items, 'work/v06/API_INVENTORY_AFTER.json is stale; re-run node scripts/api-inventory.mjs --out work/v06/API_INVENTORY_AFTER.md --json work/v06/API_INVENTORY_AFTER.json')
  }
})

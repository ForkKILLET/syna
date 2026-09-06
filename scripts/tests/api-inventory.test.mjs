// A01 / A07 (v0.6) and A11 (v0.7): the public API of this source, as `scripts/api-inventory.mjs` records it. No
// deleted name survives — neither the 0.5 names removed in 0.6 nor the 0.6 aliases removed in 0.7.0 — every kept
// name is present, and nothing is deprecated. When the 0.6.0 record and the committed AFTER inventory are present
// (source repository, not the archive), the diff against the record is exactly the registered 0.7 removals and
// additions, and the committed AFTER is current.
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

// 0.6: the 0.5 names deleted outright (D) and the helpers un-exported (M2).
const DELETED_06 = [
  'serviceRange', 'ImplementationSelector', 'ImplementationSelectorDependency', 'ImplementationLease',
  'EntryParameter', 'EntryParameterMap', 'EntryParameterValue', 'EntryParameterValues', 'EntryRunArguments',
  'DependencyOutput', 'NormalizedServiceFailurePolicy', 'SetupResult',
]
const DELETED_MEMBERS_06 = ['Contract.selector', 'DependencyRef.preload', 'ServiceRef.preload', 'InputRef.load', "InspectionNodeKind['selector']", "SynaErrorCode['UNAVAILABLE_IMPLEMENTATION']", "SynaErrorCode['CONSTRAINT_VIOLATION']", "DiagnosticCode['UNAVAILABLE_IMPLEMENTATION']", "DiagnosticCode['CONSTRAINT_VIOLATION']"]
// 0.7 (§2.1): the 23 aliases of the 0.6 migration table (docs/MIGRATION_V06_TO_V07.md) — ten type names, nine
// members of kept types, and the four members the deleted option records carried.
const DELETED_07 = ['BoundEntry', 'DependencyRef', 'DeriveOptions', 'DisposalOptions', 'InitializationOptions', 'PersistentImplementationRef', 'PlanCacheOptions', 'PlanningOptions', 'ScopeTarget', 'SynaRuntime']
const DELETED_MEMBERS_07 = ['CreateRuntimeOptions.disposal', 'CreateRuntimeOptions.initialization', 'CreateRuntimeOptions.planCache', 'CreateRuntimeOptions.planning', 'EntryDefinition.scope', 'EntryDescriptor.scope', 'EnvHandle.bind', 'ImplementationRef.implementationId', 'RuntimePolicyContext.site']
const DELETED_07_OWNED = ['DisposalOptions.graceMs', 'InitializationOptions.deadlineMs', 'PlanCacheOptions.maxEntries', 'PlanningOptions.searchBudget']
// Names the 0.6 consolidation introduced; every one of them stays.
const KEPT = [
  'Runtime', 'AnchoredEntry', 'ServiceRef', 'InputRef', 'ImplementationRef', 'ReuseConstraints', 'ReuseTarget', 'EntryOptions', 'RuntimeLimits',
  'EntryParameters', 'EntryArguments', 'LoadedDependencies', 'SynaError', 'SynaErrorOf', 'SynaErrorConstructor', 'SynaErrorDetails', 'SynaErrorCode', 'DiagnosticCode', 'isSynaError',
  'EnvHandle.anchor', 'EntryDescriptor.reuse', 'RuntimePolicyContext.dependencySite', 'ImplementationRef.familyId', 'CreateRuntimeOptions.limits',
  'RuntimeLimits.setupDeadlineMs', 'RuntimeLimits.disposalGraceMs', 'RuntimeLimits.planningBudget', 'RuntimeLimits.planCacheEntries',
  "SynaErrorCode['FRESH_CONSTRAINT_FAILED']", "SynaErrorCode['SHARE_CONSTRAINT_FAILED']", "DiagnosticCode['UNKNOWN_ERROR']",
]
// Names 0.7 adds to the public API (registered phase by phase: S6/S7 error codes and details, S1 inspection fields).
const NEW_07 = []
const ERROR_CODE_COUNT = 22

const deleted = [...DELETED_06, ...DELETED_07]
const deletedMembers = [...DELETED_MEMBERS_06, ...DELETED_MEMBERS_07, ...DELETED_07_OWNED]
const isDeleted = item => deleted.some(name => item === name || item.startsWith(`${name}.`) || item.startsWith(`${name}[`)) || deletedMembers.includes(item)

test('A01/A11 no deleted name survives and every kept name is exported', () => {
  const survivors = after.items.map(item => item.path).filter(isDeleted)
  assert.deepEqual(survivors, [], 'deleted names still in the public API')
  const missing = [...KEPT, ...NEW_07].filter(name => !paths.has(name))
  assert.deepEqual(missing, [], 'kept or new names missing from the public API')
  assert.equal(after.version, JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version)
})

test(`A11 nothing is deprecated; the error-code union has ${ERROR_CODE_COUNT} members`, () => {
  const deprecated = after.items.filter(item => item.deprecated).map(item => item.path)
  assert.deepEqual(deprecated, [], 'deprecated items in the public API')
  const codes = after.items.filter(item => /^SynaErrorCode\['/.test(item.path)).map(item => item.path.slice("SynaErrorCode['".length, -2))
  assert.equal(codes.length, ERROR_CODE_COUNT, codes.join(','))
  assert.ok(!codes.includes('CONSTRAINT_VIOLATION') && !codes.includes('UNAVAILABLE_IMPLEMENTATION') && codes.includes('FRESH_CONSTRAINT_FAILED'))
})

const before = path.join(root, 'work/v07/API_INVENTORY_BEFORE.json')
test('A11 the diff against the 0.6.0 record is exactly the registered 0.7 removals and additions (asserted where the record is present)', () => {
  // The record lives in the source repository under work/, which is never archived: inside a rebuilt archive this
  // test has nothing to diff against and asserts only that the inventory it would diff was produced.
  assert.ok(after.items.length > 300, `inventory has ${after.items.length} items`)
  if (!existsSync(before)) return
  const record = JSON.parse(readFileSync(before, 'utf8'))
  assert.equal(record.version, '0.6.0', 'the record is the 0.6.0 inventory')
  const beforePaths = new Set(record.items.map(item => item.path))
  const removed = [...beforePaths].filter(item => !paths.has(item)).sort()
  const added = [...paths].filter(item => !beforePaths.has(item)).sort()
  assert.deepEqual(removed, [...DELETED_07, ...DELETED_MEMBERS_07, ...DELETED_07_OWNED].sort(), 'the removals are the 23 aliases and their owned members, nothing else')
  assert.deepEqual(added, [...NEW_07].sort(), 'the additions are the registered 0.7 names, nothing else')
  assert.equal(record.items.filter(item => item.deprecated).length, 23, 'the record carried the 23 deprecated aliases')
  const committedAfter = path.join(root, 'work/v07/API_INVENTORY_AFTER.json')
  if (existsSync(committedAfter)) {
    const committed = JSON.parse(readFileSync(committedAfter, 'utf8'))
    assert.deepEqual(committed.items, after.items, 'work/v07/API_INVENTORY_AFTER.json is stale; re-run node scripts/api-inventory.mjs --out work/v07/API_INVENTORY_AFTER.md --json work/v07/API_INVENTORY_AFTER.json')
  }
})

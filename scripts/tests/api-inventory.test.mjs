// A01 / A07 (v0.6), A11 (v0.7) and the 0.8 rename: the public API of this source, as `scripts/api-inventory.mjs`
// records it. No deleted or renamed-away name survives — neither the 0.5 names removed in 0.6, nor the 0.6 aliases
// removed in 0.7.0, nor the 0.7 names renamed in 0.8.0 — every kept name is present, and nothing is deprecated. When
// the 0.7.0 record and the committed AFTER inventory are present (source repository, not the archive), the diff
// against the record — removed, added and changed signatures — is exactly the 0.8 rename table
// (work/v08/RENAME_TABLE.md; docs/MIGRATION_V07_TO_V08.md), nothing outside it, and the committed AFTER is current.
// 1.0.0-rc.1: the surface is frozen from 0.8.0 (docs/API_STABILITY.md) — where the 0.8.0 release gate's record is
// present, this inventory is identical to it item by item. 1.0.0-rc.2: identical to the 1.0.0-rc.1 record as well.
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
// members of kept types, and the four members the deleted option records carried; (§2.2) the selector's last
// remnants: `CandidateAvailability`, `ImplementationCandidate.availability` and `AvailableImplementationCandidate`.
const DELETED_07 = ['AvailableImplementationCandidate', 'BoundEntry', 'CandidateAvailability', 'DependencyRef', 'DeriveOptions', 'DisposalOptions', 'InitializationOptions', 'PersistentImplementationRef', 'PlanCacheOptions', 'PlanningOptions', 'ScopeTarget', 'SynaRuntime']
const DELETED_MEMBERS_07 = ['CreateRuntimeOptions.disposal', 'CreateRuntimeOptions.initialization', 'CreateRuntimeOptions.planCache', 'CreateRuntimeOptions.planning', 'EntryDefinition.scope', 'EntryDescriptor.scope', 'EnvHandle.bind', 'ImplementationCandidate.availability', 'ImplementationRef.implementationId', 'RuntimePolicyContext.site']
// 0.7 (§2.3): error codes split or removed — each code is one inventory item, its SynaErrorCode union member
// (DiagnosticCode is the union alias plus UNKNOWN_ERROR; SynaErrorDetails is a mapped type; neither has per-code items).
const codeItems = code => [`SynaErrorCode['${code}']`]
const DELETED_CODES_07 = ['FRESH_CONSTRAINT_FAILED', 'INVALID_ENV_STATE', 'UNSETTLED_ATTEMPT'].flatMap(codeItems)
const NEW_CODES_07 = ['ENV_CLOSED', 'FOREIGN_CANDIDATE_REF', 'INACTIVE_REUSE_TARGET', 'INVALID_INHERITED_CHOICE', 'LIFECYCLE_MISUSE', 'RUNTIME_CLOSED', 'SLOT_NOT_LOADABLE'].flatMap(codeItems)
const DELETED_07_OWNED = ['DisposalOptions.graceMs', 'InitializationOptions.deadlineMs', 'PlanCacheOptions.maxEntries', 'PlanningOptions.searchBudget']

// 0.8 (§2.1 T1–T7): the five renamed type names, with every member they carried (the members reappear under the new name).
const DELETED_08 = ['EntryDescriptor', 'EnvHandle', 'ImplementationDescriptor', 'InputType', 'NodeDisposition']
// 0.8 (§2.2 / §2.3): renamed members of kept types, the removed union members and the renamed error code.
const DELETED_MEMBERS_08 = [
  'ExplainCounts.inherited', 'ExplainedNode.disposition', 'ImplementationCandidate.ref', 'ImplementationRef.version', "InspectionNodeKind['all']",
  'RuntimeInspection.internalServices', 'RuntimeLimits.setupDeadlineMs', 'RuntimePolicyContext.parentActiveRevisionKeys',
  'ServiceDefinition.metadata', 'ServiceDefinition.setupDeadlineMs', 'ServiceRevision.key', 'ServiceRevision.metadata', 'ServiceRevision.setupDeadlineMs',
  "SynaErrorCode['INITIALIZATION_TIMEOUT']", "UniquenessPolicy['none']", 'UnsettledAttemptInspection.attempt', 'UnsettledAttemptInspection.runningForMs',
]
// 0.8: the new names — the five renamed types with their members, `SlotState`, and the renamed members / union members / code.
const members = (owner, names) => [owner, ...names.map(name => `${owner}.${name}`)]
const unionMembers = (owner, names) => [owner, ...names.map(name => `${owner}['${name}']`)]
const NEW_08 = [
  ...members('Entry', ['apiVersion', 'id', 'kind', 'metadata', 'package', 'parameters', 'requires', 'reuse']),
  ...members('Env', ['[Symbol.asyncDispose]', 'anchor', 'check', 'deps', 'derive', 'dispose', 'enter', 'explain', 'id', 'inspect', 'run', 'state']),
  ...members('ImplementationRecord', ['contractId', 'eager', 'familyId', 'familyMetadata', 'implementationRef', 'revisionMetadata', 'version']),
  'InputValue',
  ...unionMembers('NodePlacement', ['forked', 'new', 'reused']),
  ...unionMembers('SlotState', ['abandoned', 'disposed', 'disposing', 'dormant', 'failed', 'ready', 'starting']),
  'ExplainCounts.reused', 'ExplainedNode.placement', 'ImplementationCandidate.candidateRef', 'ImplementationRef.range', "InspectionNodeKind['all-implementations']",
  'RuntimeInspection.privateServices', 'RuntimeLimits.loadTimeoutMs', 'RuntimePolicyContext.parentActiveRevisionIds',
  'ServiceDefinition.familyMetadata', 'ServiceDefinition.loadTimeoutMs', 'ServiceRevision.id', 'ServiceRevision.loadTimeoutMs', 'ServiceRevision.revisionMetadata',
  "SynaErrorCode['LOAD_TIMEOUT']", 'UnsettledAttemptInspection.attemptNumber', 'UnsettledAttemptInspection.elapsedMs',
]
// 0.8: kept items whose signature changed because it spells a renamed name (a type, a field, a value, a parameter) — every one a table row.
const CHANGED_08 = [
  'AnchoredEntry', 'AnchoredEntry.enter', 'Binding.to', 'Dependency', 'EntryArguments', 'EntryCallback', 'EntryDependencies',
  'EntryExplanationSuccess.parameters', 'EntryExplanationSuccess.services', 'EntryParameters', 'EnvInspection.state', 'EnvInspectionNode.state',
  'ForkCause', 'ImplementationCandidate', 'ImplementationRef.kind', 'InspectionNodeKind', 'PackageDefinitions.entry',
  'Runtime.check', 'Runtime.enter', 'Runtime.explain', 'Runtime.run', 'RuntimeCatalog.implementations', 'RuntimeCatalog.resolve', 'RuntimeCatalog.revisions',
  'RuntimeEvent', 'RuntimeInspection.planCache', 'ServiceFamily.uniqueWithin', 'ServiceRevision.range', 'SynaErrorCode', 'SynaErrorDetails', 'UniquenessPolicy', 'UnsettledAttemptInspection.state',
]
// Names the 0.6 consolidation introduced; every one of them stays (under its 0.8 spelling where 0.8 renamed the owner or the member).
const KEPT = [
  'Runtime', 'AnchoredEntry', 'ServiceRef', 'InputRef', 'ImplementationRef', 'ReuseConstraints', 'ReuseTarget', 'EntryOptions', 'RuntimeLimits',
  'EntryParameters', 'EntryArguments', 'LoadedDependencies', 'SynaError', 'SynaErrorOf', 'SynaErrorConstructor', 'SynaErrorDetails', 'SynaErrorCode', 'DiagnosticCode', 'isSynaError',
  'Env.anchor', 'Entry.reuse', 'RuntimePolicyContext.dependencySite', 'ImplementationRef.familyId', 'CreateRuntimeOptions.limits',
  'RuntimeLimits.loadTimeoutMs', 'RuntimeLimits.disposalGraceMs', 'RuntimeLimits.planningBudget', 'RuntimeLimits.planCacheEntries',
  "SynaErrorCode['SHARE_CONSTRAINT_FAILED']", "DiagnosticCode['UNKNOWN_ERROR']",
]
// Names 0.7 added to the public API (S6/S7 error codes and details, S1 inspection fields); every one of them stays.
const NEW_07 = [...NEW_CODES_07, 'EnvInspectionNode.overdueMs', 'EnvInspection.abandonedAttempts']
const ERROR_CODE_COUNT = 26

const deleted = [...DELETED_06, ...DELETED_07, ...DELETED_08]
const deletedMembers = [...DELETED_MEMBERS_06, ...DELETED_MEMBERS_07, ...DELETED_07_OWNED, ...DELETED_CODES_07, ...DELETED_MEMBERS_08]
const isDeleted = item => deleted.some(name => item === name || item.startsWith(`${name}.`) || item.startsWith(`${name}[`)) || deletedMembers.includes(item)
const isDeleted08 = item => DELETED_08.some(name => item === name || item.startsWith(`${name}.`) || item.startsWith(`${name}[`)) || DELETED_MEMBERS_08.includes(item)

test('A01/A11/0.8 no deleted or renamed-away name survives and every kept or new name is exported', () => {
  const survivors = after.items.map(item => item.path).filter(isDeleted)
  assert.deepEqual(survivors, [], 'deleted names still in the public API')
  const missing = [...KEPT, ...NEW_07, ...NEW_08].filter(name => !paths.has(name))
  assert.deepEqual(missing, [], 'kept or new names missing from the public API')
  assert.equal(after.version, JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version)
})

test(`A11 nothing is deprecated; the error-code union has ${ERROR_CODE_COUNT} members`, () => {
  const deprecated = after.items.filter(item => item.deprecated).map(item => item.path)
  assert.deepEqual(deprecated, [], 'deprecated items in the public API')
  const codes = after.items.filter(item => /^SynaErrorCode\['/.test(item.path)).map(item => item.path.slice("SynaErrorCode['".length, -2))
  assert.equal(codes.length, ERROR_CODE_COUNT, codes.join(','))
  assert.deepEqual(codes, [...codes].sort(), 'the codes are declared in alphabetical order')
  assert.ok(!codes.includes('CONSTRAINT_VIOLATION') && !codes.includes('UNAVAILABLE_IMPLEMENTATION') && !codes.includes('FRESH_CONSTRAINT_FAILED') && !codes.includes('INVALID_ENV_STATE') && !codes.includes('INITIALIZATION_TIMEOUT'))
  assert.ok(codes.includes('INACTIVE_REUSE_TARGET') && codes.includes('ENV_CLOSED') && codes.includes('RUNTIME_CLOSED') && codes.includes('SLOT_NOT_LOADABLE') && codes.includes('LIFECYCLE_MISUSE') && codes.includes('LOAD_TIMEOUT'))
})

const signaturesByPath = items => {
  const map = new Map()
  for (const item of items) map.set(item.path, [...(map.get(item.path) ?? []), `${item.deprecated ? '@deprecated ' : ''}${item.signature}`].sort())
  return map
}

const before = path.join(root, 'work/v08/API_INVENTORY_BEFORE.json')
test('0.8 the diff against the 0.7.0 record is exactly the rename table: removed, added and changed signatures (asserted where the record is present)', () => {
  // The record lives in the source repository under work/, which is never archived: inside a rebuilt archive this
  // test has nothing to diff against and asserts only that the inventory it would diff was produced.
  assert.ok(after.items.length > 300, `inventory has ${after.items.length} items`)
  if (!existsSync(before)) return
  const record = JSON.parse(readFileSync(before, 'utf8'))
  assert.equal(record.version, '0.7.0', 'the record is the 0.7.0 inventory')
  assert.equal(record.items.filter(item => item.deprecated).length, 0, 'the 0.7.0 record carries no deprecated item')
  const beforePaths = new Set(record.items.map(item => item.path))
  const removed = [...beforePaths].filter(item => !paths.has(item)).sort()
  const added = [...paths].filter(item => !beforePaths.has(item)).sort()
  assert.deepEqual(removed, [...beforePaths].filter(isDeleted08).sort(), 'the removals are the five renamed types with their members, the renamed members, the removed union members and the renamed code, nothing else')
  assert.equal(removed.length, 52)
  assert.deepEqual(added, [...NEW_08].sort(), 'the additions are the 0.8 names of the table, nothing else')
  const beforeSignatures = signaturesByPath(record.items)
  const afterSignatures = signaturesByPath(after.items)
  const changed = [...afterSignatures.keys()].filter(item => beforeSignatures.has(item) && JSON.stringify(beforeSignatures.get(item)) !== JSON.stringify(afterSignatures.get(item))).sort()
  assert.deepEqual(changed, [...CHANGED_08].sort(), 'every kept item whose signature changed spells a renamed name of the table, and nothing outside the table changed')
  const committedAfter = path.join(root, 'work/v08/API_INVENTORY_AFTER.json')
  if (existsSync(committedAfter)) {
    const committed = JSON.parse(readFileSync(committedAfter, 'utf8'))
    assert.deepEqual(committed.items, after.items, 'work/v08/API_INVENTORY_AFTER.json is stale; re-run node scripts/api-inventory.mjs --out work/v08/API_INVENTORY_AFTER.md --json work/v08/API_INVENTORY_AFTER.json')
  }
})

// 1.0.0-rc.1: the public surface is frozen from 0.8.0. The record is the inventory the 0.8.0 release gate wrote
// (validation/v0.8-release/api-inventory.json, commit 38a722e); it lives in the source repository, not in the archive.
const frozen = path.join(root, 'validation/v0.8-release/api-inventory.json')
test('1.0: the inventory is identical to the 0.8.0 record, item by item — path, kind, signature, JSDoc, deprecation (asserted where the record is present)', () => {
  if (!existsSync(frozen)) return
  const record = JSON.parse(readFileSync(frozen, 'utf8'))
  assert.equal(record.version, '0.8.0', 'the record is the 0.8.0 inventory')
  assert.equal(record.items.length, 374)
  assert.deepEqual(after.items, record.items, 'the public API differs from the 0.8.0 record')
})

// 1.0.0-rc.2: nothing changed since the previous release candidate either — the record the 1.0.0-rc.1 release gate wrote
// (validation/v1.0.0-rc.1-release/api-inventory.json, provenance 77d6440), itself identical to the 0.8.0 record.
const previous = path.join(root, 'validation/v1.0.0-rc.1-release/api-inventory.json')
test('1.0.0-rc.2: the inventory is identical to the 1.0.0-rc.1 record, item by item: 0 added, 0 removed, 0 changed (asserted where the record is present)', () => {
  if (!existsSync(previous)) return
  const record = JSON.parse(readFileSync(previous, 'utf8'))
  assert.equal(record.version, '1.0.0-rc.1', 'the record is the 1.0.0-rc.1 inventory')
  assert.equal(record.items.length, 374)
  const key = item => JSON.stringify([item.path, item.kind, item.signature, item.doc ?? '', item.deprecated === true, item.note ?? ''])
  const recordKeys = new Set(record.items.map(key))
  const afterKeys = new Set(after.items.map(key))
  assert.deepEqual(after.items.filter(item => !recordKeys.has(key(item))).map(item => item.path), [], 'items added or changed since 1.0.0-rc.1')
  assert.deepEqual(record.items.filter(item => !afterKeys.has(key(item))).map(item => item.path), [], 'items removed or changed since 1.0.0-rc.1')
  assert.deepEqual(after.items, record.items, 'the public API differs from the 1.0.0-rc.1 record')
})

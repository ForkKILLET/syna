#!/usr/bin/env node
// syna-v08-rename: this script spells the pre-0.8 names on purpose — it counts them.
// Phase A census of the v0.8 rename table: for every §2 item, the inventory entries it touches
// (work/v08/API_INVENTORY_BEFORE.json) and the files that spell the old name, by area.
//
//   node work/v08/census.mjs [--out work/v08/CENSUS.md]
//
// Regex counts are an upper bound for the names that also mean something else (`.key`, `.metadata`, `.ref`,
// `.version`, `attempt`, `'all'`, `'inherited'`); the codemod report (scripts/codemod-v08.mjs --json) has the exact
// edit counts for the consumers.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined

const ITEMS = [
  ['T1', 'type', '`EnvHandle`', '`Env`', /\bEnvHandle\b/],
  ['T2', 'type', '`EntryDescriptor`', '`Entry`', /\bEntryDescriptor\b/],
  ['T3', 'type', '`ImplementationDescriptor`', '`ImplementationRecord`', /\bImplementationDescriptor\b/],
  ['T4', 'type', '`NodeDisposition`', '`NodePlacement`', /\bNodeDisposition\b/],
  ['T5', 'type', '`InputType<I>`', '`InputValue<I>`', /\bInputType\b/],
  ['T6', 'type', '(new) `SlotState`', "`'dormant' | 'starting' | 'ready' | 'failed' | 'disposing' | 'disposed' | 'abandoned'`", /\bSlotState\b|\bServiceSlotState\b/],
  ['T7', 'type', "`UniquenessPolicy = 'none' | 'lineage'`", "`UniquenessPolicy = 'lineage'`; `ServiceFamily.uniqueWithin?: UniquenessPolicy`", /\bUniquenessPolicy\b|'none'\s*\|\s*'lineage'|uniqueWithin[^\n]*'none'/],
  ['F1', 'field', '`ServiceRevision.key`', '`id`', /\b[A-Z]\w*\.key\b|\b(revision|service|candidate|origin|target|canonical|source|copy[AB]?)\.key\b|readonly key: string/],
  ['F2', 'field', '`RuntimePolicyContext.parentActiveRevisionKeys`', '`parentActiveRevisionIds`', /\bparentActiveRevisionKeys\b/],
  ['F3', 'field', '`INVALID_INHERITED_CHOICE.details.selectedKey`', '`selectedRevision`', /\bselectedKey\b/],
  ['F4', 'field', '`ServiceDefinition.metadata`', '`familyMetadata`', /\bdefinition\.metadata\b|readonly metadata\?: DescriptorMetadata|\bmetadata: \{/],
  ['F5', 'field', '`ServiceRevision.metadata`', '`revisionMetadata`', /\b(revision|source|Db\d?|[A-Z]\w*)\.metadata\b|readonly metadata: Readonly<DescriptorMetadata>/],
  ['F6', 'field', '`ImplementationCandidate.ref`', '`candidateRef`', /\bcandidate\.ref\b|readonly ref: CandidateRef|\bref: this\.createRef/],
  ['F7', 'field', '`ImplementationRecord.persistentRef`', '`implementationRef`', /\bpersistentRef\b/],
  ['F8', 'parameter', '`Binding.to(service, version?)`, `ServiceRevision.range(version?)`', '`range`', /\bto\([^)]*version[^)]*\)|\brange\(version/],
  ['F9', 'field + JSON key', '`ImplementationRef.version`; the 0.5 key `implementationId` read path', '`range`; no old key (`INVALID_DESCRIPTOR`)', /\bref\.version\b|\bimplementationId\b|\bisLegacyImplementationRef\b|\bfamilyIdOf\b|\bnormalizeImplementationRef\b|LEGACY_(KEY_MARKER|FAMILY_KEY)|persistent-implementation-ref[^\n]*version|version: '[\^~*>=<\d]/],
  ['F10', 'field', '`RuntimeInspection.internalServices`', '`privateServices`', /\binternalServices\b/],
  ['F11', 'field', '`RuntimeInspection.planCache.maxEntries`', '`limit`', /planCache\.maxEntries|planCache:\s*\{[^}]*maxEntries|readonly maxEntries: number|\bmaxEntries: (this\.)?(capacity|limit)|\bmaxEntries\b.*planCache/],
  ['F12', 'field', '`EntryExplanationSuccess.parameters.bindingsResolved`', '`bindingsAssigned`', /\bbindingsResolved\b/],
  ['F13', 'field', '`ExplainedNode.disposition`', '`placement`', /\bdisposition\b/],
  ['F14', 'field', '`UnsettledAttemptInspection.runningForMs`', '`elapsedMs`', /\brunningForMs\b/],
  ['F15', 'field', '`attempt: number` (events, ledger, `LOAD_TIMEOUT` / `LIFECYCLE_MISUSE` details)', '`attemptNumber`', /\battempt: (number|attempt\.id|record\.id|\d)|\.details\.attempt\b|\b(event|events\[\d+\]|item|entry|record)\.attempt\b|\battempt:\s*[a-z]+\[\d\]\.attempt/],
  ['F16', 'field', '`ServiceDefinition.setupDeadlineMs`, `RuntimeLimits.setupDeadlineMs`', '`loadTimeoutMs`', /\bsetupDeadlineMs\b/],
  ['F17', 'field', '`ServiceRevision.setupDeadlineMs`', '`loadTimeoutMs`', /\bsetupDeadlineMs\b/],
  ['F18', 'field', '`LINEAGE_UNIQUENESS_CONFLICT.details.anchorSlot / anchorRevision`', '`pinnedSlot / pinnedRevision`', /\banchorSlot\b|\banchorRevision\b/],
  ['F19', 'value', "`ImplementationRef.kind: 'persistent-implementation-ref'`", "`'implementation-ref'`", /persistent-implementation-ref/],
  ['D1', 'value', '`INITIALIZATION_TIMEOUT`', '`LOAD_TIMEOUT`', /\bINITIALIZATION_TIMEOUT\b/],
  ['D2', 'value', "ForkCause `'anchor-dependency-mismatch'`", "`'pinned-dependency-mismatch'`", /anchor-dependency-mismatch/],
  ['D3', 'value', "`InspectionNodeKind` `'all'`", "`'all-implementations'`", /\bkind\b[^\n]{0,24}'all'(?!-)|'all'(?!-)[^\n]{0,12}\bkind\b|\| 'all'$|\| 'all'\s|NodeKind[^\n]*'all'/],
  ['D4', 'value', "`NodePlacement` `'inherited'`", "`'reused'`", /\b(disposition|placement)\b[^\n]*'inherited'|'inherited'[^\n]*\b(disposition|placement)\b|'inherited'\s*\|\s*'new'/],
  ['D5', 'field', '`ExplainCounts.inherited`, `services.eagerInherited`', '`reused`, `eagerReused`', /\b(services|synthetic)\.inherited\b|\beagerInherited\b|\binherited:\s[^\n]*\beagerToStart\b|readonly inherited: number/],
  ['D6', 'type', '`EnvInspection.state: string`, `EnvInspectionNode.state: string`, `attempt-abandoned.dependencies[].state: string`', '`EnvState`, `SlotState`, `SlotState`', /readonly state: string/],
  ['D7', 'value', "`UnsettledAttemptInspection.state` `'timed-out'`", "`'overdue'`", /timed-out/],
  ['D8', 'event', '`late-setup-result` / `late-setup-failure` / `attempts-outstanding` / `foreign-thenable-setup`', '`attempt-succeeded-late` / `attempt-failed-late` / `runtime-attempts-outstanding` / `setup-returned-thenable`', /late-setup-result|late-setup-failure|(?<!runtime-)attempts-outstanding|foreign-thenable-setup/],
  ['D9', 'value', "`ServiceFamily.uniqueWithin: 'none'`", '`undefined` when undeclared', /uniqueWithin[^\n]*'none'|'none'[^\n]*uniqueWithin|'none'\s*\|\s*'lineage'/],
  ['D10', 'event', '`legacy-implementation-ref`', '(deleted)', /legacy-implementation-ref/],
  ['S1', 'structure', '`env.derive(reuse?: ReuseConstraints)`', '`derive(options?: EntryOptions)`', /\.derive\(\{\s*(fresh|share)\b|derive\(reuse|\.derive\((?!\)|\{\s*reuse)[a-z]/],
  ['S2', 'structure', '`catalog.revisions(familyId: string)`', '`revisions(family: ServiceFamily)`', /\.revisions\(['"]|\.revisions\([^)]*\.family\.id\)|revisions\(familyId/],
]

const AREAS = {
  'core src': ['packages/core/src'],
  'core tests': ['packages/core/tests', 'packages/core/type-tests'],
  consumers: ['apps', 'benchmarks', 'scripts', '.github', ...readdirSync(path.join(root, 'packages')).filter(name => name !== 'core' && name !== 'tsconfig').map(name => `packages/${name}`)],
  docs: ['README.md', 'README.zh-CN.md', 'packages/core/README.md', 'docs/API_REFERENCE.md', 'docs/API_STABILITY.md', 'docs/ARCHITECTURE.md', 'docs/DEFERRED.md', 'docs/HYLA_MINI.md', 'docs/PACKAGE_AUTHORING.md', 'docs/PLUGIN_AUTHORING.md', 'docs/SEMANTIC_MODEL.md'],
}
const SKIP = new Set(['node_modules', 'dist', 'work', '.git', 'snapshots'])
const EXTENSIONS = ['.ts', '.mjs', '.js', '.cjs', '.yml', '.md', '.json']
const EXCLUDED_FILES = new Set(['scripts/codemod-v08.mjs', 'scripts/tests/no-old-names.test.mjs', 'scripts/tests/api-inventory.test.mjs'])

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue
    const file = path.join(dir, name)
    if (statSync(file).isDirectory()) yield* walk(file)
    else if (EXTENSIONS.some(extension => name.endsWith(extension))) yield file
  }
}
const filesOf = area => {
  const files = []
  for (const entry of AREAS[area]) {
    const file = path.join(root, entry)
    try { if (statSync(file).isDirectory()) files.push(...walk(file)); else files.push(file) } catch { /* absent */ }
  }
  return files.map(file => path.relative(root, file)).filter(file => !EXCLUDED_FILES.has(file))
}
const contents = new Map()
const read = file => { if (!contents.has(file)) contents.set(file, readFileSync(path.join(root, file), 'utf8')); return contents.get(file) }

const inventory = JSON.parse(readFileSync(path.join(root, 'work/v08/API_INVENTORY_BEFORE.json'), 'utf8'))
const lines = []
lines.push('# v0.8 rename census (Phase A)')
lines.push('')
lines.push(`Generated by \`node work/v08/census.mjs\` on commit ${inventory.commit} (inventory \`work/v08/API_INVENTORY_BEFORE.json\`, ${inventory.items.length} items). Counts are files spelling the old name (regex; an upper bound for the ambiguous names, see the header of the script); the codemod report has the exact consumer edits.`)
lines.push('')
lines.push('| # | category | old | new | inventory entries | core src | core tests | consumers | docs |')
lines.push('|---|---|---|---|---|---:|---:|---:|---:|')
const details = []
for (const [id, category, from, to, pattern] of ITEMS) {
  const entries = inventory.items.filter(item => pattern.test(item.path) || pattern.test(item.signature)).map(item => item.path)
  const counts = {}
  const where = {}
  for (const area of Object.keys(AREAS)) {
    const hits = []
    for (const file of filesOf(area)) {
      const text = read(file)
      const matching = text.split('\n').map((line, index) => (pattern.test(line) ? index + 1 : 0)).filter(Boolean)
      if (matching.length > 0) hits.push(`${file} (${matching.length}: ${matching.slice(0, 12).join(', ')}${matching.length > 12 ? ', …' : ''})`)
    }
    counts[area] = hits.length
    where[area] = hits
  }
  const shown = entries.length > 6 ? `${entries.slice(0, 6).map(entry => `\`${entry}\``).join(', ')} +${entries.length - 6}` : entries.map(entry => `\`${entry}\``).join(', ') || '—'
  lines.push(`| ${id} | ${category} | ${from} | ${to} | ${shown} | ${counts['core src']} | ${counts['core tests']} | ${counts.consumers} | ${counts.docs} |`)
  details.push(`## ${id} — ${from} → ${to}`, '', `Regex: \`${pattern.source}\``, '', `Inventory entries (${entries.length}): ${entries.map(entry => `\`${entry}\``).join(', ') || '—'}`, '')
  for (const area of Object.keys(AREAS)) {
    details.push(`- ${area} (${where[area].length}):${where[area].length === 0 ? ' —' : ''}`)
    for (const hit of where[area]) details.push(`  - ${hit}`)
  }
  details.push('')
}
lines.push('')
lines.push(...details)
const text = lines.join('\n') + '\n'
if (out) { writeFileSync(path.resolve(root, out), text); console.log(`wrote ${out}`) } else process.stdout.write(text)

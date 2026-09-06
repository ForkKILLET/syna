// v0.6 (Phase D): the applications, demos, benchmarks, scripts, workflow and the core test suites use the
// 0.6 names only. The deprecated 0.5 aliases live in `packages/core/src` (policed by deprecations.test.mjs);
// the only places allowed to spell an old name are files or lines marked `syna-v05-compat` (the
// migration-equivalence tests and the 0.5 stored-document compatibility in Hyla-mini), and, in the current
// documentation, the deprecation table and lines that explain the 0.5 → 0.6 change.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'

const root = new URL('../../', import.meta.url).pathname.replace(/\/$/, '')
const MARKER = 'syna-v05-compat'

// Old name → what replaced it (the message names the replacement).
const OLD_NAMES = [
  [/\bSynaRuntime\b/, 'Runtime'],
  [/\bBoundEntry\b/, 'AnchoredEntry'],
  [/\.bind\([A-Z]\w*\)/, 'env.anchor(entry)'],
  [/\bDependencyRef\b/, 'ServiceRef'],
  [/\bPersistentImplementationRef\b/, 'ImplementationRef'],
  [/\bimplementationId\b/, 'familyId'],
  [/\bDeriveOptions\b/, 'ReuseConstraints'],
  [/\bScopeTarget\b/, 'ReuseTarget'],
  [/\.scope\b/, '.reuse'],
  [/\bscope:\s*[{[]/, 'reuse (definition) or the { reuse } call options'],
  [/\bcontext\.site\b(?!\.)/, 'context.dependencySite'],
  [/\.preload\(/, 'load()'],
  [/(?<!\.)\.selector\b/, 'C.all'],
  [/\bImplementationSelector(Dependency)?\b/, 'ImplementationSet (C.all)'],
  [/\bImplementationLease\b/, 'ImplementationSet (C.all)'],
  [/implementation-selector/, 'the all-collection node kind'],
  [/\bUNAVAILABLE_IMPLEMENTATION\b/, '(deleted with the selector)'],
  [/\bCONSTRAINT_VIOLATION\b/, 'FRESH_CONSTRAINT_FAILED'],
  [/\bserviceRange\b/, 'revision.range()'],
  [/\b(planCache|initialization|disposal|planning):\s*\{/, 'limits: { … }'],
  [/\b(initialization\.deadlineMs|disposal\.graceMs|planning\.searchBudget)\b/, 'limits.<key>'],
  [/\bPlanCacheOptions\b|\bInitializationOptions\b|\bDisposalOptions\b|\bPlanningOptions\b/, 'RuntimeLimits'],
  [/\bEntryParameterValues?\b|\bEntryRunArguments\b/, 'EntryArguments'],
  [/\bEntryParameterMap\b|\bEntryParameter\b/, 'EntryParameters'],
  [/\bNormalizedServiceFailurePolicy\b|\bSetupResult\b|\bDependencyOutput\b/, '(no longer exported)'],
  [/\b__(api|value|publicApi|contract)\b/, '__type'],
]

const CODE_ROOTS = ['apps', 'benchmarks', 'scripts', '.github', 'packages/core/tests', 'packages/core/type-tests']
  .concat(readdirSync(join(root, 'packages')).filter(name => name !== 'core' && name !== 'tsconfig').map(name => `packages/${name}`))
const CODE_EXTENSIONS = ['.ts', '.mjs', '.js', '.cjs', '.yml', '.yaml']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'work', '.tsbuildinfo'])
const SELF = 'scripts/tests/no-old-names.test.mjs'
const DEPRECATIONS_TEST = 'scripts/tests/deprecations.test.mjs'

// Current documentation. Ledgers and the migration tables describe history and are not scanned.
const DOCS = [
  'README.md', 'README.zh-CN.md', 'packages/core/README.md',
  'docs/API_REFERENCE.md', 'docs/ARCHITECTURE.md', 'docs/HYLA_MINI.md', 'docs/PACKAGE_AUTHORING.md', 'docs/PLUGIN_AUTHORING.md', 'docs/SEMANTIC_MODEL.md', 'docs/API_STABILITY.md',
]
const DOC_CONTEXT = /0\.7\.0|deprecated|弃用|removed|删除|0\.5|compat/i

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (CODE_EXTENSIONS.some(extension => name.endsWith(extension))) yield path
  }
}

function codeFiles() {
  const files = []
  for (const codeRoot of CODE_ROOTS) {
    const path = join(root, codeRoot)
    let stats
    try { stats = statSync(path) }
    catch { continue }
    if (stats.isDirectory()) files.push(...walk(path))
    else files.push(path)
  }
  return files.map(path => relative(root, path)).filter(path => path !== SELF && path !== DEPRECATIONS_TEST).sort()
}

function scan(file, { allowLine }) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n')
  if (lines.slice(0, 5).some(line => line.includes(MARKER))) return { exempt: true, hits: [] }
  const hits = []
  lines.forEach((line, index) => {
    if (line.includes(MARKER) || allowLine(line, index, lines)) return
    for (const [pattern, replacement] of OLD_NAMES) {
      if (pattern.test(line)) hits.push(`${file}:${index + 1}: ${pattern.source} → use ${replacement}: ${line.trim().slice(0, 120)}`)
    }
  })
  return { exempt: false, hits }
}

test('no 0.5 name survives in the applications, benchmarks, scripts, workflow and core test suites', () => {
  const files = codeFiles()
  assert.ok(files.length > 100, `scanned ${files.length} files`)
  const hits = []
  const exempt = []
  for (const file of files) {
    const result = scan(file, { allowLine: () => false })
    if (result.exempt) exempt.push(file)
    hits.push(...result.hits)
  }
  assert.deepEqual(hits, [], `old names found:\n${hits.join('\n')}`)
  // The exemptions are the known compatibility files, nothing else.
  assert.deepEqual(exempt, [
    'apps/hyla-mini/src/domain/recipe-schema.ts',
    'apps/hyla-mini/tests/v06-compat.test.mjs',
    'packages/core/tests/v06-m1-limits.test.mjs',
    'packages/core/tests/v06-r1-reuse.test.mjs',
    'packages/core/tests/v06-r2-anchor.test.mjs',
    'packages/core/tests/v06-r3-runtime.test.mjs',
    'packages/core/tests/v06-r4-service-ref.test.mjs',
    'packages/core/tests/v06-r5-implementation-ref.test.mjs',
    'packages/core/tests/v06-r6-dependency-site.test.mjs',
    'packages/core/tests/v06-snapshots.test.mjs',
    'packages/core/type-tests/api.ts',
  ])
})

test('the current documentation spells old names only in the deprecation table or next to the 0.6 name', () => {
  const hits = []
  for (const file of DOCS) {
    try { statSync(join(root, file)) }
    catch { continue }
    let inDeprecationSection = false
    const result = scan(file, {
      allowLine: line => {
        if (/^## /.test(line)) inDeprecationSection = /deprecat|弃用/i.test(line)
        return inDeprecationSection || DOC_CONTEXT.test(line)
      },
    })
    assert.equal(result.exempt, false, `${file} must not carry a file-level ${MARKER} marker`)
    hits.push(...result.hits)
  }
  assert.deepEqual(hits, [], `old names found:\n${hits.join('\n')}`)
})

test('the scanner recognises every old name it is meant to catch', () => {
  const samples = [
    'const runtime: SynaRuntime = createRuntime({ services: [] })',
    'const bound: BoundEntry<typeof Entry> = env.bind(Entry)',
    'const ref: DependencyRef<Db> = deps.db',
    'const persisted: PersistentImplementationRef = { implementationId: "x" }',
    'const options: DeriveOptions = { fresh: [] }; const target: ScopeTarget = Db',
    'define.entry("x", { requires: {}, scope: { fresh: [Db] } })',
    'policy: candidates => candidates.filter(c => context.site === "x")',
    'void deps.db.preload()',
    'requires: { picker: Capability.selector }',
    'if (error.code === "CONSTRAINT_VIOLATION") {}',
    'requires: { db: serviceRange(Db, "^1") }',
    'createRuntime({ services: [], planCache: { maxEntries: 3 } })',
    'const values: EntryParameterValues<typeof Entry> = {}',
    'interface X { readonly __api?: T }',
  ]
  for (const sample of samples) {
    assert.ok(OLD_NAMES.some(([pattern]) => pattern.test(sample)), `not caught: ${sample}`)
  }
  for (const fine of [
    'const runtime: Runtime = createRuntime({ services: [], limits: { planCacheEntries: 3 } })',
    'const anchored = env.anchor(Entry); const fn = this.handle.bind(this)',
    'assert.equal(inFlight.context.site.title, "Alpha")',
    'const providers = makeDefine("test.collection-provider")',
    'const all = [...implementations]',
    'const values: EntryArguments<typeof Entry> = {}',
  ]) {
    assert.ok(!OLD_NAMES.some(([pattern]) => pattern.test(fine)), `false positive: ${fine}`)
  }
})

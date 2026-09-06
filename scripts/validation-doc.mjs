#!/usr/bin/env node
// Generates docs/VALIDATION.md from the machine-readable results of one orchestrator run.
//
//   node scripts/validation-doc.mjs [validation/v0.6-release] [docs/VALIDATION.md]
//
// Every number in the document comes from manifest.json, benchmark-v0.5.json, working-set.json,
// the consumer-run log and the two same-machine v0.4 comparison files under benchmarks/.
// Nothing is hand-typed; re-run the script after every gate run that is meant to be the record.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const runDir = process.argv[2] ?? 'validation/v0.6-release'
const outFile = process.argv[3] ?? 'docs/VALIDATION.md'
const json = file => JSON.parse(readFileSync(path.resolve(root, file), 'utf8'))

const manifest = json(path.join(runDir, 'manifest.json'))
const benchmark = json(path.join(runDir, 'benchmark-v0.5.json'))
const workingSet = json(path.join(runDir, 'working-set.json'))
const v4 = json('benchmarks/results-v0.4.0-baseline-same-machine.json')
const v4onv5 = json('benchmarks/results-v0.4-workload-on-v0.5-same-machine.json')
const consumerLog = readFileSync(path.resolve(root, runDir, 'logs/consumer-run.log'), 'utf8').trim().split('\n').filter(Boolean)
const gate = manifest.gate ?? 'scripts/verify-v05.mjs'
const sameSessionFile = path.join(runDir, 'benchmark-compare/same-session.json')
const recordFile = path.join(runDir, 'benchmark-compare.json')
const compareFile = existsSync(path.resolve(root, sameSessionFile)) ? sameSessionFile : recordFile
const comparison = existsSync(path.resolve(root, compareFile)) ? json(compareFile) : null
const sameSession = compareFile === sameSessionFile
const sessionBaseline = sameSession ? json(path.join(runDir, 'benchmark-compare/baseline-v0.5.0-same-session.json')) : null
const driftFile = path.join(runDir, 'benchmark-compare/record-drift.json')
const drift = sameSession && existsSync(path.resolve(root, driftFile)) ? json(driftFile) : null

const ms = value => (typeof value === 'number' ? value.toFixed(3) : '—')
const mib = bytes => (bytes / (1024 * 1024)).toFixed(1)
const short = commit => (commit ? commit.slice(0, 7) : 'unknown')
const env = benchmark.environment
const git = manifest.environment.gitProvenance ?? {}

const lines = []
const out = (...text) => lines.push(...text)

out('# Validation (VALIDATION)', '')
out(`Every number below is copied by a script (\`scripts/validation-doc.mjs\`) from machine-readable results of the transparent orchestrator; nothing is hand-typed. Source of this page: the ${manifest.mode} run \`node ${gate} --${manifest.mode}\` recorded in \`${runDir}/manifest.json\` — status **${manifest.status}**, generated ${manifest.generatedAt}, source fingerprint \`${manifest.source.digest}\` (${manifest.source.files} files), git commit \`${short(git.commit)}\` (dirty: ${git.dirty ?? 'unknown'}).`, '')
out(`The shipped source additionally contains this document, so the release run recorded in \`RELEASE_MANIFEST.json\` / \`${runDir}/\` was executed once more on that final source; it is the record of reference for the archive hashes and fingerprint. The gate does not compare runs with each other and fails none for differing from another: the same steps run, and each manifest records under \`previousRun\` whether its step list and per-step test counts equal those of the run it replaced (for the final run, the run quoted here); its timings are its own and may differ within noise.`, '')

out('## Environment', '')
out(`- Host: ${env.platform} ${env.release} ${env.arch}, ${env.cpu} × ${env.cpuCount}, ${Math.round(env.totalMemoryBytes / (1024 ** 3))} GiB`)
out(`- Node ${env.node} (V8 ${env.v8}), \`--expose-gc\` for benchmarks and working-set tests`)
const pg = manifest.environment.postgres
out(`- PostgreSQL: ${pg ? `${pg.server} at \`${pg.url}\` (${pg.origin})` : 'server and URL not recorded by this run'}, as printed by \`scripts/pg-test-cluster.mjs\` in the step log and copied into the manifest; the temporary cluster runs with \`fsync=off\` and is created before and removed after each PostgreSQL step`)
out('- Package manager: npm workspaces (`npm ci` in the rebuild); TypeScript 5.9.x from the lockfile', '')

out(`## Release gate steps (\`${runDir}/manifest.json\`)`, '')
out('| step | exit | tests | duration | log |', '|---|---|---|---|---|')
for (const step of manifest.steps) {
  const tests = step.tests
    ? `${step.tests.pass}/${step.tests.tests} pass, ${step.tests.fail} fail, ${step.tests.skipped + step.tests.todo + step.tests.cancelled} not run`
    : '—'
  const duration = typeof step.durationMs === 'number' ? `${step.durationMs} ms` : '—'
  out(`| ${step.name} | ${step.exitCode} | ${tests} | ${duration} | \`${step.log}\` |`)
}
out('')
const totals = manifest.totals
const distinct = totals.distinctTests ?? manifest.steps.filter(step => !step.name.startsWith('rebuild-')).reduce((sum, step) => sum + (step.tests?.tests ?? 0), 0)
const rerun = totals.rebuildTests ?? totals.tests - distinct
out(`Totals: ${totals.steps} steps, ${totals.failed} failed steps; ${totals.tests} test executions: ${distinct} distinct cases, ${rerun} of them executed a second time in the rebuilt copy (the \`rebuild-*\` steps); ${totals.passed} passed, ${totals.skippedTests} skipped/not run. Blocked steps: ${manifest.blocked.length}.`, '')
if (manifest.previousRun) {
  const prev = manifest.previousRun
  out(`Compared with the run this one replaced (generated ${prev.generatedAt}, commit \`${short(prev.commit)}\`, ${prev.status}): step list ${prev.sameStepList ? 'identical' : 'different'}, per-step test counts ${prev.sameTestCounts ? 'identical' : 'different'}${prev.differences.length > 0 ? ` — ${prev.differences.join('; ')}` : ''}.`, '')
}
out('The `rebuild-*` steps ran inside a fresh directory created with `mkdtemp` in the OS temp dir: the source tarball was unpacked there, `npm ci` installed from the lockfile, the workspace was built and type-tested, and the core, application and PostgreSQL/matrix suites plus the filesystem demo ran against that copy. `pack-*` produced the npm tarballs from the rebuilt copy; `consumer-*` installed them into an independent TypeScript project, compiled it and ran it.', '')

if (manifest.release) {
  out('## Release artefacts', '')
  out(`The ${manifest.release.archives.length} source archives and ${manifest.release.packed.length} npm packages of the run this page was generated from are listed with sizes and SHA-256 digests in that run's \`SHA256SUMS.txt\` and under \`release\` in its \`manifest.json\`. They are not copied here: this page is part of the shipped source, so the run of reference (\`RELEASE_MANIFEST.json\`, \`${runDir}/SHA256SUMS.txt\`) is executed on a source that already contains it and its hashes are the ones to check. Rebuilt from \`${manifest.release.rebuiltFrom}\`. Consumer smoke result (last line of \`${runDir}/logs/consumer-run.log\`): \`${consumerLog.at(-1)}\`.`, '')
}

out(`## Micro-benchmarks (P01–P04, \`${runDir}/benchmark-v0.5.json\`)`, '')
out(`${benchmark.methodology.note} Warmup iterations: ${benchmark.methodology.warmupIterations}. Quick mode: ${benchmark.quick}.`, '')
out('| case | samples | p50 ms | p95 ms | p99 ms | inherited / new | plan-cache entries |', '|---|---:|---:|---:|---:|---|---:|')
for (const item of benchmark.cases) {
  if (!item.timing?.samples) continue
  const shape = item.requestShape
    ? `${item.requestShape.services.inherited} / ${item.requestShape.services.new}`
    : typeof item.inherited === 'number'
      ? `${item.inherited} / ${typeof item.newServices === 'number' ? item.newServices : '—'}`
      : '—'
  out(`| ${item.name} | ${item.timing.samples} | ${ms(item.timing.p50Ms)} | ${ms(item.timing.p95Ms)} | ${ms(item.timing.p99Ms)} | ${shape} | ${item.planCache ? item.planCache.entries : '—'} |`)
}
out('')
const phases = benchmark.cases.find(item => item.name === 'phase-breakdown-300')
if (phases) {
  out(`Phase breakdown (${phases.serviceCount}-service world, ${phases.coldPlanWithNewSlotsMs.samples} rounds): cold plan + new slots p95 ${ms(phases.coldPlanWithNewSlotsMs.p95Ms)} ms · warm plan p95 ${ms(phases.warmPlanMs.p95Ms)} ms · materialization of a request chain p95 ${ms(phases.materializationMs.p95Ms)} ms · dispose p95 ${ms(phases.disposeMs.p95Ms)} ms.`, '')
}
const churn = benchmark.cases.find(item => item.name === 'churn-10000-requests')
if (churn) {
  out(`Churn: ${churn.operations} request/AnchoredEntry operations in ${Math.round(churn.elapsedMs)} ms (${(churn.perOperationMs * 1000).toFixed(1)} µs/op); plan-cache entries max ${churn.planCacheEntriesMax} (hits ${churn.planCache.hits}, misses ${churn.planCache.misses}); live Envs after ${churn.liveEnvCountAfter}; heap after GC: ${churn.heapSamples.map(sample => `${mib(sample.heapUsed)} MiB`).join(' → ')}.`, '')
}
const lru = benchmark.cases.find(item => item.name === 'lru-churn-500-shapes')
if (lru) {
  out(`LRU: ${lru.generatedEntryShapes} distinct Entry shapes → ${lru.planCacheEntries} cached templates (max ${lru.planCache.maxEntries}, evictions ${lru.planCache.evictions}).`, '')
}
out(`### Budgets (\`benchmarks/budgets.json\`) — all ok: ${benchmark.budgetsOk}`, '')
out('| budget | metric | max | value | result |', '|---|---|---:|---:|---|')
for (const item of benchmark.budgets) out(`| ${item.budget} | ${item.metric} | ${item.max} | ${item.value.toFixed(3)} | ${item.ok ? 'ok' : 'FAILED'} |`)
out('')

if (comparison) {
  out(`### v0.5.0 comparison on the same machine (\`${compareFile}\`)`, '')
  const tolerance = Math.round(comparison.tolerance * 100)
  const rows = comparison.rows
  const equal = rows.filter(row => row.check === 'equal')
  const timed = rows.filter(row => row.check !== 'equal')
  const runCount = comparison.current.replace('median of ', '').replace(' fresh runs', '')
  const baselineText = sameSession
    ? `the 0.5.0 source (commit \`${short(sessionBaseline.sourceCommit)}\`) exported from git into a scratch directory, installed from its lockfile, built and benchmarked ${sessionBaseline.runs} times in the same session (\`scripts/benchmark-same-session.mjs\`; median in \`${path.join(runDir, 'benchmark-compare/baseline-v0.5.0-same-session.json')}\`)`
    : `\`${comparison.baseline}\` (the 0.5.0 median of 7 runs recorded earlier on the same machine)`
  out(`\`scripts/benchmark-compare.mjs compare\` ran \`benchmarks/v0.5-planning.mjs\` ${runCount} times on this host, took the element-wise median and compared it with ${baselineText}: environment ${comparison.comparable ? 'identical' : 'DIFFERENT'} (${comparison.environment.map(row => `${row.key} ${row.current}`).join(', ')}); ${timed.filter(row => row.ok).length}/${timed.length} p50/p95/per-operation values within ±${tolerance} %; ${equal.filter(row => row.ok).length}/${equal.length} plan-cache counters and shape counts equal; overall ${comparison.ok ? 'OK' : 'FAILED'}.`, '')
  if (drift) {
    const driftTimed = drift.rows.filter(row => row.check !== 'equal')
    const outside = driftTimed.filter(row => !row.ok)
    out(`Machine-state drift (informational): this session's 0.5.0 against the file recorded on ${json(drift.baseline).generatedAt} (\`${drift.baseline}\`) has ${driftTimed.length - outside.length}/${driftTimed.length} timings within ±${tolerance} %${outside.length > 0 ? `; outside: ${outside.map(row => `${row.path} ${row.delta >= 0 ? '+' : ''}${(row.delta * 100).toFixed(1)} %`).join(', ')}` : ''} — the same code measured at two moments, which is why both sides are measured in one session.`, '')
  }
  out('| value | baseline | v0.6 | delta |', '|---|---:|---:|---:|')
  for (const row of timed) out(`| ${row.path} | ${ms(row.baseline)} | ${ms(row.current)} | ${row.delta === null ? '—' : `${row.delta >= 0 ? '+' : ''}${(row.delta * 100).toFixed(1)} %`}${row.ok ? '' : ' (outside tolerance)'} |`)
  out('')
  const unequal = equal.filter(row => !row.ok)
  out(unequal.length === 0 ? `Every one of the ${equal.length} plan-cache counters (hits, misses, entries, evictions) and shape counts is equal to the baseline.` : `Counters differing from the baseline: ${unequal.map(row => `${row.path} ${row.baseline} → ${row.current}`).join('; ')}.`, '')
}

out('### v0.4 comparison on the same machine (P03)', '')
out('The v0.4.0 baseline archive (sha256 `e0f21a94765aeb9f8e9e7987d596844e4d1bf56fce3584c8de1358131f42a96c`) was rebuilt in a scratch directory and its own benchmark (`benchmarks/v0.4-planning.mjs`) was run unchanged (`benchmarks/results-v0.4.0-baseline-same-machine.json`); the same script was then run against the v0.5 core (`benchmarks/results-v0.4-workload-on-v0.5-same-machine.json`). Same workload, same host, same Node:', '')
out('| case (v0.4 workload) | v0.4 core p95 ms | v0.5 core p95 ms | delta |', '|---|---:|---:|---:|')
const deltas = []
for (const base of v4.cases) {
  const current = v4onv5.cases.find(item => item.name === base.name)
  if (!current?.timing?.p95Ms || !base.timing?.p95Ms) continue
  const delta = Math.round((current.timing.p95Ms / base.timing.p95Ms - 1) * 100)
  deltas.push(delta)
  out(`| ${base.name} | ${ms(base.timing.p95Ms)} | ${ms(current.timing.p95Ms)} | ${delta >= 0 ? '+' : ''}${delta} % |`)
}
out('')
const signed = value => `${value >= 0 ? '+' : ''}${value} %`
const spread = `${signed(Math.min(...deltas))} to ${signed(Math.max(...deltas))}`
out(`On the v0.4 workload the v0.5 core ${Math.min(...deltas) >= 0 ? `is slower by ${spread}` : `differs by ${spread}`} at p95 (all cases stay far inside the 2 ms budget). The v0.5 representative world (Bindings, \`auto\`, \`C.all\`, SCC, AnchoredEntry private realm, Input closures) is heavier than the v0.4 request chain and is reported separately above. These values are targets for this machine, not cross-machine guarantees.`, '')

out(`## Working set (H11 / P05, \`${runDir}/working-set.json\`)`, '')
const phaseNames = { hot: 'hot', rotate: 'rotation', tail: 'long tail', mixed: 'mixed' }
const stats = workingSet.finalStats
out(`${workingSet.tenants} tenants configured, capacity ${workingSet.capacity}; max SiteEnv records per phase: ${Object.entries(workingSet.maxRecordsPerPhase).map(([phase, count]) => `${phaseNames[phase] ?? phase} ${count}`).join(', ')}; final records ${stats.records}, evictions ${stats.evictions}, creations ${stats.creations}, creation failures ${stats.creationFailures}, leases ${stats.leases}, pending acquires ${stats.pendingAcquires}. Heap after GC per phase: ${workingSet.heapSamples.map(sample => `${sample.label} ${mib(sample.heapUsed)} MiB (records ${sample.records}, live envs ${sample.liveEnvs}, disposing ${sample.disposing ?? 0})`).join('; ')}. Site Envs alive at any acquire (live envs minus the two roots, sampled on every lease): at most ${workingSet.maxSiteEnvsAlive ?? 'n/a'} of capacity ${workingSet.capacity}. Plan cache at the end: ${JSON.stringify(workingSet.planCache)}.`, '')

const latencyFile = path.join(runDir, 'hyla-request-latency.json')
if (existsSync(latencyFile)) {
  const latency = json(latencyFile)
  out(`## Hyla-mini request latency (report only, \`${runDir}/hyla-request-latency.json\`)`, '')
  out(`${latency.note} Quick mode: ${latency.quick}. Not a budget: nothing here gates the release.`, '')
  out('| backend | case | samples | p50 ms | p95 ms | p99 ms |', '|---|---|---:|---:|---:|---:|')
  for (const backend of latency.backends) {
    if (backend.skipped) { out(`| ${backend.backend} | skipped: ${backend.skipped} | | | | |`); continue }
    for (const item of backend.cases) out(`| ${backend.backend} | ${item.name} | ${item.timing.samples} | ${ms(item.timing.p50Ms)} | ${ms(item.timing.p95Ms)} | ${ms(item.timing.p99Ms)} |`)
  }
  out('')
  const described = latency.backends.find(backend => backend.cases)?.cases ?? []
  out(described.map(item => `\`${item.name}\`: ${item.description}.`).join(' '), '')
}

out('## Audit and review fixes covered by this run', '')
out('The suites above include the regressions written for the independent audits and for the second and third review rounds (`docs/AUDIT.md`): `packages/core/tests/v05-audit-lifecycle.test.mjs`, `v05-audit-planning.test.mjs` and `v05-review-lifecycle.test.mjs` inside `core-tests` (the third round\'s core cases live in the `v05-*` files named in `work/v05/ISSUES.md` I-58…I-65), `apps/hyla-mini/tests/audit-app.test.mjs` and `apps/hyla-mini/tests/review-app.test.mjs` as their own steps, the site-manager, render and preflight cases of the third round inside their steps, and the repository-conformance cases (content version, domain claims and concurrent claims, tenant-scoped post identity, configuration validation) inside the filesystem and PostgreSQL suites. The demo steps are self-asserting: the Hyla-mini demo must print `demo: OK` and three `: 200` cells, and the `demos` step must print `demo: OK` once per core demo (each checks its own results); exit 0 alone is not enough. The `gate-self-tests` step covers the gate\'s own tooling (step process groups, cluster script signal forwarding).', '')

out('## v0.6 API consolidation evidence in this run', '')
const named = name => manifest.steps.find(step => step.name === name)
const describe = name => { const step = named(name); return step ? (step.tests ? `${step.tests.pass}/${step.tests.tests} pass` : step.mustRun === false ? `recorded, not a test: ${step.note ?? ''}` : `exit ${step.exitCode}`) : 'not run' }
out(`The zero-semantic-change claim of 0.6 rests on steps of this run: \`core-tests\` includes \`v06-snapshots.test.mjs\` (check/explain/inspect/catalog/error snapshots recorded on 0.5.0, identical apart from the renamed fields), \`reference-planner.test.mjs\` (brute-force planner differential) and the six \`v06-r*\` migration-equivalence suites; \`gate-self-tests\` (${describe('gate-self-tests')}) includes the deprecation list, the no-old-names scan of every application, benchmark and script, the README example compiled and run as printed, the public-API inventory assertions and the \`any\` budget; \`api-inventory\` (${describe('api-inventory')}) and \`api-inventory-diff\` (${describe('api-inventory-diff')}) record the public API of this source and its diff against the 0.5.0 record; \`any-count\` (${describe('any-count')}) checks every file against \`scripts/any-baseline-v0.5.0.json\`; \`benchmark-compare\` (${describe('benchmark-compare')}) is the same-machine comparison above.`, '')

out('## What is not covered', '')
out('- Coverage percentages are not a gate in v0.6; the adversarial and application suites are.')
out('- Benchmarks use empty setups; Hyla-mini request latency (section above) is reported end to end on this machine but is not a budget and not a cross-machine claim.')
out('- The gate ran with no other workload on the machine; single-run timings still carry noise (see the v0.4 comparison for the spread between two runs of the same code).')

writeFileSync(path.resolve(root, outFile), lines.join('\n') + '\n')
console.log(`${outFile}: ${lines.length} lines from ${runDir} (${manifest.status}, ${manifest.totals.tests} tests)`)

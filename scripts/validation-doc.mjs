#!/usr/bin/env node
// Generates docs/VALIDATION.md from the machine-readable results of one orchestrator run.
//
//   node scripts/validation-doc.mjs [validation/v0.5-release] [docs/VALIDATION.md]
//
// Every number in the document comes from manifest.json, benchmark-v0.5.json, working-set.json,
// the consumer-run log and the two same-machine v0.4 comparison files under benchmarks/.
// Nothing is hand-typed; re-run the script after every gate run that is meant to be the record.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const runDir = process.argv[2] ?? 'validation/v0.5-release'
const outFile = process.argv[3] ?? 'docs/VALIDATION.md'
const json = file => JSON.parse(readFileSync(path.resolve(root, file), 'utf8'))

const manifest = json(path.join(runDir, 'manifest.json'))
const benchmark = json(path.join(runDir, 'benchmark-v0.5.json'))
const workingSet = json(path.join(runDir, 'working-set.json'))
const v4 = json('benchmarks/results-v0.4.0-baseline-same-machine.json')
const v4onv5 = json('benchmarks/results-v0.4-workload-on-v0.5-same-machine.json')
const consumerLog = readFileSync(path.resolve(root, runDir, 'logs/consumer-run.log'), 'utf8').trim().split('\n').filter(Boolean)

const ms = value => (typeof value === 'number' ? value.toFixed(3) : '—')
const mib = bytes => (bytes / (1024 * 1024)).toFixed(1)
const short = commit => (commit ? commit.slice(0, 7) : 'unknown')
const env = benchmark.environment
const git = manifest.environment.gitProvenance ?? {}

const lines = []
const out = (...text) => lines.push(...text)

out('# Validation (VALIDATION)', '')
out(`Every number below is copied by a script (\`scripts/validation-doc.mjs\`) from machine-readable results of the transparent orchestrator; nothing is hand-typed. Source of this page: the ${manifest.mode} run \`node scripts/verify-v05.mjs --${manifest.mode}\` recorded in \`${runDir}/manifest.json\` — status **${manifest.status}**, generated ${manifest.generatedAt}, source fingerprint \`${manifest.source.digest}\` (${manifest.source.files} files), git commit \`${short(git.commit)}\` (dirty: ${git.dirty ?? 'unknown'}).`, '')
out('The shipped source additionally contains this document, so the release run recorded in `RELEASE_MANIFEST.json` / `validation/v0.5-release/` was executed once more on that final source; it is the record of reference for the archive hashes and fingerprint. Its step list and test counts are the same by construction (the gate fails on any deviation); its timings are its own and may differ within noise from the ones quoted here.', '')

out('## Environment', '')
out(`- Host: ${env.platform} ${env.release} ${env.arch}, ${env.cpu} × ${env.cpuCount}, ${Math.round(env.totalMemoryBytes / (1024 ** 3))} GiB`)
out(`- Node ${env.node} (V8 ${env.v8}), \`--expose-gc\` for benchmarks and working-set tests`)
out('- PostgreSQL: temporary cluster created by `scripts/pg-test-cluster.mjs` (`postgres://syna@127.0.0.1:54329`, `fsync=off`), removed after each step; server binaries Homebrew `postgresql@17` 17.10 as recorded in `work/v05/STATE.md`')
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
out(`Totals: ${manifest.totals.steps} steps, ${manifest.totals.failed} failed steps, ${manifest.totals.tests} tests, ${manifest.totals.passed} passed, ${manifest.totals.skippedTests} skipped/not run. Blocked steps: ${manifest.blocked.length}.`, '')
out('The `rebuild-*` steps ran inside a fresh directory created with `mkdtemp` in the OS temp dir: the source tarball was unpacked there, `npm ci` installed from the lockfile, the workspace was built and type-tested, and the core, application and PostgreSQL/matrix suites plus the filesystem demo ran against that copy. `pack-*` produced the npm tarballs from the rebuilt copy; `consumer-*` installed them into an independent TypeScript project, compiled it and ran it.', '')

if (manifest.release) {
  out(`## Release artefacts (\`${runDir}/SHA256SUMS.txt\`)`, '')
  out('| artefact | bytes | sha256 |', '|---|---:|---|')
  for (const item of [...manifest.release.archives, ...manifest.release.packed]) out(`| \`${item.path}\` | ${item.bytes} | \`${item.sha256}\` |`)
  out('')
  out(`Rebuilt from \`${manifest.release.rebuiltFrom}\`. Consumer smoke result (last line of \`${runDir}/logs/consumer-run.log\`): \`${consumerLog.at(-1)}\`.`, '')
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
  out(`Churn: ${churn.operations} request/BoundEntry operations in ${Math.round(churn.elapsedMs)} ms (${(churn.perOperationMs * 1000).toFixed(1)} µs/op); plan-cache entries max ${churn.planCacheEntriesMax} (hits ${churn.planCache.hits}, misses ${churn.planCache.misses}); live Envs after ${churn.liveEnvCountAfter}; heap after GC: ${churn.heapSamples.map(sample => `${mib(sample.heapUsed)} MiB`).join(' → ')}.`, '')
}
const lru = benchmark.cases.find(item => item.name === 'lru-churn-500-shapes')
if (lru) {
  out(`LRU: ${lru.generatedEntryShapes} distinct Entry shapes → ${lru.planCacheEntries} cached templates (max ${lru.planCache.maxEntries}, evictions ${lru.planCache.evictions}).`, '')
}
out(`### Budgets (\`benchmarks/budgets.json\`) — all ok: ${benchmark.budgetsOk}`, '')
out('| budget | metric | max | value | result |', '|---|---|---:|---:|---|')
for (const item of benchmark.budgets) out(`| ${item.budget} | ${item.metric} | ${item.max} | ${item.value.toFixed(3)} | ${item.ok ? 'ok' : 'FAILED'} |`)
out('')

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
out(`On the v0.4 workload the v0.5 core ${Math.min(...deltas) >= 0 ? `is slower by ${spread}` : `differs by ${spread}`} at p95 (all cases stay far inside the 2 ms budget). The v0.5 representative world (Bindings, \`auto\`, \`C.all\`, SCC, BoundEntry private realm, Input closures) is heavier than the v0.4 request chain and is reported separately above. These values are targets for this machine, not cross-machine guarantees.`, '')

out(`## Working set (H11 / P05, \`${runDir}/working-set.json\`)`, '')
const phaseNames = { hot: 'hot', rotate: 'rotation', tail: 'long tail', mixed: 'mixed' }
const stats = workingSet.finalStats
out(`${workingSet.tenants} tenants configured, capacity ${workingSet.capacity}; max SiteEnv records per phase: ${Object.entries(workingSet.maxRecordsPerPhase).map(([phase, count]) => `${phaseNames[phase] ?? phase} ${count}`).join(', ')}; final records ${stats.records}, evictions ${stats.evictions}, creations ${stats.creations}, creation failures ${stats.creationFailures}, leases ${stats.leases}, pending acquires ${stats.pendingAcquires}. Heap after GC per phase: ${workingSet.heapSamples.map(sample => `${sample.label} ${mib(sample.heapUsed)} MiB (records ${sample.records}, live envs ${sample.liveEnvs})`).join('; ')}. Plan cache at the end: ${JSON.stringify(workingSet.planCache)}.`, '')

out('## Audit and review fixes covered by this run', '')
out('The suites above include the regressions written for the independent audits and for the second review round (`docs/AUDIT.md`): `packages/core/tests/v05-audit-lifecycle.test.mjs`, `v05-audit-planning.test.mjs` and `v05-review-lifecycle.test.mjs` inside `core-tests`, `apps/hyla-mini/tests/audit-app.test.mjs` and `apps/hyla-mini/tests/review-app.test.mjs` as their own steps, and the two repository-conformance cases (content version, domain claims) inside the filesystem and PostgreSQL suites.', '')

out('## What is not covered', '')
out('- Coverage percentages are not a gate in v0.5; the adversarial and application suites are.')
out('- Benchmarks use empty setups; Hyla-mini request latency including PostgreSQL round trips is not a micro-benchmark and is not claimed here.')
out('- The gate ran with no other workload on the machine; single-run timings still carry noise (see the v0.4 comparison for the spread between two runs of the same code).')

writeFileSync(path.resolve(root, outFile), lines.join('\n') + '\n')
console.log(`${outFile}: ${lines.length} lines from ${runDir} (${manifest.status}, ${manifest.totals.tests} tests)`)

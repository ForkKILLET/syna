#!/usr/bin/env node
// Syna v0.5 acceptance orchestrator.
//
//   node scripts/verify-v05.mjs --dev       G0: build + type tests + core/regression + real PostgreSQL/FS + app matrix + benchmarks
//   node scripts/verify-v05.mjs --release   G0 + G1: source archive, rebuild from the archive in an empty dir, pack + consumer smoke,
//                                            release manifest and SHA256SUMS. Prints COMPLETE / PARTIAL / BLOCKED and exits 0 only on COMPLETE.
//
// This is a transparent runner: every sub-command is spawned, awaited, and recorded with exit code, timing,
// pass/fail/skip counts (parsed from TAP) and a log path. Nothing here writes "passed" by hand.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { constants, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createStepRunner } from './lib/step-runner.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const release = args.has('--release')
const dev = args.has('--dev') || !release
const insideArchive = args.has('--inside-archive') // set by the release step when re-running inside the unpacked archive
const validationDir = path.join(root, 'validation', release ? 'v0.5-release' : 'v0.5-dev')
const logsDir = path.join(validationDir, 'logs')
mkdirSync(logsDir, { recursive: true })
// The manifest this run replaces (if any) is read for comparison only; it never fails a run (I-116).
const manifestPath = path.join(validationDir, 'manifest.json')
const previousManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
let postgresInfo = null

const startedAt = new Date()
const steps = []
let blocked = []

function log(message) {
  process.stdout.write(`${message}\n`)
}

// Steps run in their own process groups under a bounded timeout policy: scripts/lib/step-runner.mjs (I-111).
const runner = createStepRunner({ root, logsDir, log, portable })
const run = runner.run
// A signal to the gate ends the running step's whole process tree before the gate exits.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    log(`${signal}: ending the running step`)
    void runner.abort('SIGTERM').then(() => process.exit(128 + constants.signals[signal]))
  })
}

/** The Hyla-mini demo must have served all three cells (two HTTP tenants, one static build) with 200 and said so. */
function demoServedAllCells(output) {
  return /^demo: .* → HTTP alpha \/posts\/shared-slug: 200 /m.test(output)
    && /^demo: .* → HTTP beta \/posts\/shared-slug: 200 /m.test(output)
    && /^demo: .* → static alpha \/posts\/shared-slug\/ \(\d+ files\): 200 /m.test(output)
    && /^demo: OK$/m.test(output)
}

/** The cluster script prints the server the step ran against; the manifest records it instead of a hand-typed version (I-115). */
function describePostgres(step) {
  const match = readFileSync(path.join(root, step.log), 'utf8').match(/^pg-test-cluster: server (.+?) at (postgres:\/\/\S+) \((.+?)\)$/m)
  return match ? { server: match[1], url: match[2], origin: match[3] } : null
}

/**
 * How this run relates to the manifest it replaces: same step list, same per-step test counts, or which
 * differences. Recorded, never used to fail the run — a new test is a legitimate difference (I-116).
 */
function compareWithPrevious(previous) {
  if (!previous || !Array.isArray(previous.steps)) return null
  const names = list => list.map(step => step.name)
  const before = new Map(previous.steps.map(step => [step.name, step]))
  const after = new Map(steps.map(step => [step.name, step]))
  const differences = []
  for (const name of before.keys()) if (!after.has(name)) differences.push(`step ${name} no longer runs`)
  for (const name of after.keys()) if (!before.has(name)) differences.push(`step ${name} is new`)
  const countChanges = []
  for (const [name, step] of after) {
    const old = before.get(name)
    if (!old?.tests || !step.tests) continue
    if (step.tests.tests !== old.tests.tests || step.tests.pass !== old.tests.pass) countChanges.push(`${name}: ${old.tests.pass}/${old.tests.tests} → ${step.tests.pass}/${step.tests.tests}`)
  }
  return {
    generatedAt: previous.generatedAt ?? null,
    commit: previous.environment?.gitProvenance?.commit ?? null,
    sourceDigest: previous.source?.digest ?? null,
    status: previous.status ?? null,
    sameStepList: JSON.stringify(names(previous.steps)) === JSON.stringify(names(steps)),
    sameTestCounts: countChanges.length === 0,
    differences: [...differences, ...countChanges],
  }
}

/** Manifests must not leak the host's directory layout: the workspace root becomes `<root>`. */
function portable(text) {
  return text.split(root).join('<root>')
}

function gitInfo() {
  try {
    const { execSync } = process.getBuiltinModule('node:child_process')
    const commit = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const dirty = execSync('git status --porcelain', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0
    return { commit, dirty }
  }
  catch {
    return { commit: null, dirty: null, note: 'not a git repository or git unavailable' }
  }
}

/** Source fingerprint: sha256 over the sorted list of (path, sha256(content)) for every archived source file. */
function listSourceFiles() {
  const include = ['packages', 'apps', 'benchmarks', 'docs', 'scripts', 'validation/README.md']
  const rootFiles = ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'README.zh-CN.md', 'LICENSE', 'CHANGELOG.md', '.gitignore', '.npmrc', 'MIGRATION_V04_TO_V05.md']
  const excludeDir = new Set(['node_modules', 'dist', 'dist-local', '.tsbuildinfo', 'work', 'coverage'])
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (excludeDir.has(entry.name) || entry.name.startsWith('.tsbuildinfo') || entry.name === '.DS_Store') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(path.relative(root, full))
    }
  }
  for (const dir of include) {
    const full = path.join(root, dir)
    if (existsSync(full) && statSync(full).isDirectory()) walk(full)
    else if (existsSync(full)) files.push(dir)
  }
  for (const file of rootFiles) if (existsSync(path.join(root, file))) files.push(file)
  const githubDir = path.join(root, '.github')
  if (existsSync(githubDir)) walk(githubDir)
  return [...new Set(files)].filter(file => !file.includes('/dist/') && !file.startsWith('validation/v0.5-dev')).sort()
}

function fingerprint(files) {
  const hash = createHash('sha256')
  const entries = files.map(file => {
    const digest = createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')
    hash.update(`${file}\n${digest}\n`)
    return { file, sha256: digest }
  })
  return { algorithm: 'sha256(path\\nsha256(content)\\n...)', files: entries.length, digest: hash.digest('hex') }
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

async function developmentGate() {
  // Build from source: never trust an existing dist.
  await run('clean', 'npm', ['run', 'clean'], { mustRun: true })
  await run('build', 'npm', ['run', 'build'])
  await run('type-tests', 'npm', ['run', 'type-tests'])
  await run('core-tests', 'node', ['--test', '--test-reporter=tap', ...glob('packages/core/tests', '.test.mjs')], { noSkip: true })
  await run('hyla-filesystem-tests', 'node', ['--test', '--test-reporter=tap', 'apps/hyla-mini/tests/filesystem.test.mjs'], { noSkip: true })
  await run('hyla-render-tests', 'node', ['--test', '--test-reporter=tap', 'apps/hyla-mini/tests/render.test.mjs'], { noSkip: true })
  await run('hyla-tenants-auth-preflight-tests', 'node', ['--test', '--test-reporter=tap', 'apps/hyla-mini/tests/tenants-auth.test.mjs', 'apps/hyla-mini/tests/preflight.test.mjs'], { noSkip: true })
  await run('hyla-audit-regression-tests', 'node', ['--test', '--test-reporter=tap', 'apps/hyla-mini/tests/audit-app.test.mjs'], { noSkip: true })
  await run('hyla-review-regression-tests', 'node', ['--test', '--test-reporter=tap', 'apps/hyla-mini/tests/review-app.test.mjs'], { noSkip: true })
  await run('hyla-site-manager-working-set-tests', 'node', ['--test', '--test-reporter=tap', '--expose-gc', 'apps/hyla-mini/tests/site-manager.test.mjs'], { noSkip: true, env: { SYNA_WORKING_SET_OUT: path.join(validationDir, 'working-set.json') } })
  // Real PostgreSQL: a temporary cluster (or SYNA_TEST_PG_URL). Never skipped; a missing server is BLOCKED.
  const pgStep = await run('hyla-postgres-and-matrix-tests', 'node', [
    'scripts/pg-test-cluster.mjs', 'with', '--',
    'node', '--test', '--test-reporter=tap', 'apps/hyla-mini/tests/postgres.test.mjs', 'apps/hyla-mini/tests/matrix.test.mjs',
  ], { noSkip: true, env: { SYNA_PG_CLUSTER_DIR: path.join(root, 'work', release ? 'pg-release' : 'pg-dev') } })
  if (!pgStep.ok && !pgStep.tests) {
    blocked.push({ step: pgStep.name, reason: 'PostgreSQL could not be started or reached (see log). Provide SYNA_TEST_PG_URL or install postgresql@17 binaries.' })
  }
  postgresInfo = describePostgres(pgStep)
  // The gate's own tooling: step-runner process groups and the cluster script's signal forwarding (I-111, I-115).
  await run('gate-self-tests', 'node', ['--test', '--test-reporter=tap', ...glob('scripts/tests', '.test.mjs')], { noSkip: true })
  // The four core demos check their own results and each prints `demo: OK` (I-112).
  await run('demos', 'npm', ['run', 'demo'], { expectStdout: output => (output.match(/^demo: OK$/gm) ?? []).length === 4 })
  await run('hyla-demo-filesystem', 'node', ['apps/hyla-mini/bin/hyla-mini.mjs', 'demo', '--root', path.join(root, 'work', 'demo-content')], { expectStdout: demoServedAllCells })
  rmSync(path.join(root, 'work', 'demo-content'), { recursive: true, force: true })
  await run('benchmarks', 'node', ['--expose-gc', 'benchmarks/v0.5-planning.mjs', path.join(validationDir, 'benchmark-v0.5.json')])
  // Report only (no budget): end-to-end request latency on both backends, PostgreSQL through the temporary cluster.
  await run('hyla-request-latency', 'node', [
    'scripts/pg-test-cluster.mjs', 'with', '--',
    'node', 'benchmarks/hyla-request-latency.mjs', path.join(validationDir, 'hyla-request-latency.json'),
  ], { env: { SYNA_PG_CLUSTER_DIR: path.join(root, 'work', release ? 'pg-release' : 'pg-dev') } })
  if (!existsSync(path.join(validationDir, 'working-set.json'))) {
    steps.push({ name: 'working-set-report', ok: false, exitCode: 1, mustRun: true, command: 'internal', log: path.relative(root, path.join(validationDir, 'working-set.json')), note: 'site-manager tests did not write the working-set report' })
  }
}

function glob(dir, suffix) {
  return readdirSync(path.join(root, dir)).filter(file => file.endsWith(suffix)).sort().map(file => path.join(dir, file))
}

async function releaseGate(sourceFingerprint) {
  const releaseDir = path.join(root, 'work', 'release')
  rmSync(releaseDir, { recursive: true, force: true })
  mkdirSync(releaseDir, { recursive: true })
  const archiveBase = `syna-v0.5.0-source`
  const stagingDir = path.join(releaseDir, archiveBase)
  mkdirSync(stagingDir, { recursive: true })
  const files = listSourceFiles()
  for (const file of files) {
    const target = path.join(stagingDir, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(path.join(root, file)))
  }
  // Absolute-path and secret scan on the staged tree.
  const offenders = []
  for (const file of files) {
    const content = readFileSync(path.join(stagingDir, file), 'utf8')
    if (/\/Users\/[a-z]|\/home\/[a-z]/.test(content) && !file.startsWith('validation/')) offenders.push(`${file}: absolute home path`)
    if (/postgres:\/\/[^\s'"`$]+:[^\s'"`$]+@/.test(content)) offenders.push(`${file}: credential-bearing connection string`)
  }
  writeFileSync(path.join(validationDir, 'archive-scan.json'), JSON.stringify({ files: files.length, offenders }, null, 2))
  if (offenders.length > 0) {
    steps.push({ name: 'archive-scan', ok: false, exitCode: 1, mustRun: true, command: 'internal', log: 'validation/v0.5-release/archive-scan.json', offenders })
    log(`FAIL archive-scan: ${offenders.join('; ')}`)
  }
  else {
    steps.push({ name: 'archive-scan', ok: true, exitCode: 0, mustRun: true, command: 'internal', log: 'validation/v0.5-release/archive-scan.json' })
    log('ok   archive-scan')
  }
  const tarPath = path.join(releaseDir, `${archiveBase}.tar.gz`)
  const zipPath = path.join(releaseDir, `${archiveBase}.zip`)
  await run('archive-tar', 'tar', ['-czf', tarPath, '-C', releaseDir, archiveBase])
  await run('archive-zip', 'zip', ['-qr', zipPath, archiveBase], { cwd: releaseDir })
  const archives = [tarPath, zipPath].filter(existsSync).map(file => ({ path: path.relative(root, file), bytes: statSync(file).size, sha256: sha256File(file) }))

  // Rebuild from the tarball in a fresh empty directory: install from lockfile, compile, run the must-run suites.
  const rebuildDir = await mkdtemp(path.join(tmpdir(), 'syna-v05-rebuild-'))
  await run('rebuild-unpack', 'tar', ['-xzf', tarPath, '-C', rebuildDir])
  const unpacked = path.join(rebuildDir, archiveBase)
  const rebuildLogs = { cwd: unpacked }
  await run('rebuild-install', 'npm', ['ci', '--no-fund', '--no-audit'], rebuildLogs)
  await run('rebuild-build', 'npm', ['run', 'build'], rebuildLogs)
  await run('rebuild-type-tests', 'npm', ['run', 'type-tests'], rebuildLogs)
  await run('rebuild-core-tests', 'node', ['--test', '--test-reporter=tap', ...readdirSync(path.join(unpacked, 'packages/core/tests')).filter(f => f.endsWith('.test.mjs')).sort().map(f => `packages/core/tests/${f}`)], { ...rebuildLogs, noSkip: true })
  await run('rebuild-app-tests', 'node', ['--test', '--test-reporter=tap', '--expose-gc', 'apps/hyla-mini/tests/filesystem.test.mjs', 'apps/hyla-mini/tests/render.test.mjs', 'apps/hyla-mini/tests/tenants-auth.test.mjs', 'apps/hyla-mini/tests/preflight.test.mjs', 'apps/hyla-mini/tests/audit-app.test.mjs', 'apps/hyla-mini/tests/review-app.test.mjs', 'apps/hyla-mini/tests/site-manager.test.mjs'], { ...rebuildLogs, noSkip: true })
  await run('rebuild-postgres-matrix-tests', 'node', ['scripts/pg-test-cluster.mjs', 'with', '--', 'node', '--test', '--test-reporter=tap', 'apps/hyla-mini/tests/postgres.test.mjs', 'apps/hyla-mini/tests/matrix.test.mjs'], { ...rebuildLogs, noSkip: true, env: { SYNA_PG_CLUSTER_DIR: path.join(rebuildDir, 'pg') } })
  await run('rebuild-gate-self-tests', 'node', ['--test', '--test-reporter=tap', ...readdirSync(path.join(unpacked, 'scripts/tests')).filter(f => f.endsWith('.test.mjs')).sort().map(f => `scripts/tests/${f}`)], { ...rebuildLogs, noSkip: true })
  await run('rebuild-demo', 'node', ['apps/hyla-mini/bin/hyla-mini.mjs', 'demo', '--root', path.join(rebuildDir, 'demo-content')], { ...rebuildLogs, expectStdout: demoServedAllCells })

  // Package tarball + independent consumer project.
  const packDir = path.join(releaseDir, 'pack')
  mkdirSync(packDir, { recursive: true })
  await run('pack-core', 'npm', ['pack', '--pack-destination', packDir, path.join(unpacked, 'packages/core')], { cwd: packDir })
  await run('pack-tsconfig', 'npm', ['pack', '--pack-destination', packDir, path.join(unpacked, 'packages/tsconfig')], { cwd: packDir })
  const packed = readdirSync(packDir).filter(file => file.endsWith('.tgz')).map(file => ({ path: path.relative(root, path.join(packDir, file)), bytes: statSync(path.join(packDir, file)).size, sha256: sha256File(path.join(packDir, file)) }))
  const consumerDir = path.join(rebuildDir, 'consumer')
  mkdirSync(consumerDir, { recursive: true })
  const coreTgz = packed.find(item => item.path.includes('syna-core'))
  const tsconfigTgz = packed.find(item => item.path.includes('syna-tsconfig'))
  writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({
    name: '@smoke/consumer', version: '7.3.1', private: true, type: 'module',
    imports: { '#syna/package': './package.json' },
    syna: { id: 'smoke.consumer' },
    scripts: { build: 'tsc -p tsconfig.json', start: 'node dist/index.js' },
    dependencies: { '@syna/core': `file:${path.join(root, coreTgz.path)}` },
    devDependencies: { '@syna/tsconfig': `file:${path.join(root, tsconfigTgz.path)}`, typescript: readFileSync(path.join(root, 'package.json'), 'utf8').match(/"typescript": "([^"]+)"/)[1], '@types/node': readFileSync(path.join(root, 'package.json'), 'utf8').match(/"@types\/node": "([^"]+)"/)[1] },
  }, null, 2))
  writeFileSync(path.join(consumerDir, 'tsconfig.json'), JSON.stringify({ extends: '@syna/tsconfig/node-app.json', compilerOptions: { rootDir: 'src', outDir: 'dist', composite: false, sourceMap: false }, include: ['src/**/*.ts'] }, null, 2))
  mkdirSync(path.join(consumerDir, 'src'), { recursive: true })
  writeFileSync(path.join(consumerDir, 'src/index.ts'), `import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage, type InputRef } from '@syna/core'

const define = definePackage(packageJson)
const Answer = define.input<number>('answer')
const Doubler = define.service('doubler', {
  requires: { answer: Answer },
  setup({ answer }) {
    const ref: InputRef<number> = answer
    return { result: ref.read() * 2 }
  },
})
const Main = define.entry({ requires: { doubler: Doubler }, parameters: { answer: Answer } })
const runtime = createRuntime({ services: [Doubler] })
const result = await runtime.run(Main, { answer: 21 }, async ({ doubler }) => (await doubler.load()).result)
const explanation = await runtime.explain(Main, { answer: 1 })
console.log(JSON.stringify({ result, revision: Doubler.version, explainOk: explanation.ok }))
await runtime.dispose()
`)
  await run('consumer-install', 'npm', ['install', '--no-fund', '--no-audit'], { cwd: consumerDir })
  await run('consumer-build', 'npm', ['run', 'build'], { cwd: consumerDir })
  const smoke = await run('consumer-run', 'npm', ['run', '-s', 'start'], { cwd: consumerDir })
  const smokeOutput = readFileSync(path.join(root, smoke.log), 'utf8').trim().split('\n').at(-1)
  let smokeJson
  try { smokeJson = JSON.parse(smokeOutput) } catch { smokeJson = null }
  const smokeOk = smokeJson?.result === 42 && smokeJson?.revision === '7.3.1' && smokeJson?.explainOk === true
  steps.push({ name: 'consumer-smoke-result', ok: smokeOk, exitCode: smokeOk ? 0 : 1, mustRun: true, command: 'internal', log: smoke.log, output: smokeJson })
  log(`${smokeOk ? 'ok  ' : 'FAIL'} consumer-smoke-result ${smokeOutput}`)
  rmSync(rebuildDir, { recursive: true, force: true })
  return { archives, packed, sourceFingerprint, rebuiltFrom: path.relative(root, tarPath) }
}

// Provenance is captured before any step runs, so files this run writes cannot make the checkout look dirty.
const gitProvenance = gitInfo()
const sourceFiles = listSourceFiles()
const sourceFingerprint = fingerprint(sourceFiles)
log(`Syna v0.5 verify (${release ? 'release' : 'dev'}) — ${sourceFingerprint.files} source files, fingerprint ${sourceFingerprint.digest}`)
await developmentGate()
let releaseResult
if (release && !insideArchive) releaseResult = await releaseGate(sourceFingerprint)

const mustRun = steps.filter(step => step.mustRun !== false)
const failed = mustRun.filter(step => !step.ok)
const skipped = mustRun.reduce((sum, step) => sum + (step.tests?.skipped ?? 0), 0)
// The `rebuild-*` steps run the same suites a second time inside the unpacked archive: their
// tests are executions of cases already counted, not additional cases.
const isRebuild = step => step.name.startsWith('rebuild-')
const sumTests = (predicate, key) => steps.filter(predicate).reduce((sum, step) => sum + (step.tests?.[key] ?? 0), 0)
const status = blocked.length > 0 ? 'BLOCKED' : failed.length === 0 && skipped === 0 ? 'COMPLETE' : 'PARTIAL'
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const manifest = {
  name: 'Syna v0.5.0 + Hyla-mini',
  version: packageJson.version,
  status,
  mode: release ? 'release' : 'dev',
  generatedAt: new Date().toISOString(),
  startedAt: startedAt.toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch, cwd: '.', gitProvenance, postgres: postgresInfo },
  source: sourceFingerprint,
  steps,
  totals: {
    steps: steps.length,
    failed: failed.length,
    skippedTests: skipped,
    /** Test executions across all steps (a case run twice counts twice). */
    tests: sumTests(() => true, 'tests'),
    passed: sumTests(() => true, 'pass'),
    /** Distinct test cases: executions outside the `rebuild-*` steps. */
    distinctTests: sumTests(step => !isRebuild(step), 'tests'),
    /** Executions inside the `rebuild-*` steps (the same cases run a second time on the rebuilt copy). */
    rebuildTests: sumTests(isRebuild, 'tests'),
  },
  blocked,
  previousRun: compareWithPrevious(previousManifest),
  ...(releaseResult ? { release: releaseResult } : {}),
}
writeFileSync(path.join(validationDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
if (release && releaseResult) {
  writeFileSync(path.join(root, 'RELEASE_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  // The root SHA256SUMS.txt belongs to the task documents shipped with the
  // workspace and is left alone; release hashes live next to the release manifest.
  const sums = [...releaseResult.archives, ...releaseResult.packed].map(item => `${item.sha256}  ${item.path}`).join('\n')
  writeFileSync(path.join(validationDir, 'SHA256SUMS.txt'), `${sums}\n`)
}
log('')
log(`== ${status} == ${manifest.totals.tests} test executions (${manifest.totals.distinctTests} distinct cases, ${manifest.totals.rebuildTests} re-run in the rebuilt copy), ${manifest.totals.passed} passed, ${failed.length} failed steps, ${skipped} skipped tests`)
log(`source fingerprint: ${sourceFingerprint.digest} (${sourceFingerprint.files} files)`)
if (manifest.previousRun) log(`previous run ${manifest.previousRun.generatedAt} (commit ${manifest.previousRun.commit?.slice(0, 7) ?? 'unknown'}, ${manifest.previousRun.status}): same step list ${manifest.previousRun.sameStepList}, same test counts ${manifest.previousRun.sameTestCounts}${manifest.previousRun.differences.length > 0 ? `; ${manifest.previousRun.differences.join('; ')}` : ''}`)
for (const step of steps) log(`  ${step.ok ? 'ok  ' : 'FAIL'} ${step.name.padEnd(40)} exit=${step.exitCode}${step.tests ? ` pass=${step.tests.pass} fail=${step.tests.fail} skip=${step.tests.skipped}` : ''} log=${step.log}`)
if (releaseResult) {
  for (const item of [...releaseResult.archives, ...releaseResult.packed]) log(`  archive ${item.path} ${item.bytes} bytes sha256 ${item.sha256}`)
}
log(`manifest: ${path.relative(root, path.join(validationDir, 'manifest.json'))}`)
process.exit(status === 'COMPLETE' ? 0 : status === 'BLOCKED' ? 3 : 2)

#!/usr/bin/env node
// Same-session benchmark comparison with 0.5.0 (A09). The 0.5.0 source is exported from its git commit into a
// scratch directory, installed from its lockfile, built and benchmarked N times; the current tree is benchmarked
// N times in the same session; the two medians are compared by scripts/benchmark-compare.mjs (every p50/p95/
// per-operation value within ±tolerance, every plan-cache counter and shape count equal). Measuring both sides in
// one session removes the machine-state drift a recorded baseline file carries (thermal state, background load,
// OS updates): the recorded 0.5.0 file is compared with this session's 0.5.0 as well and reported as `recordDrift`
// (informational; it says how far the machine moved, not how the code did).
//
//   node scripts/benchmark-same-session.mjs --commit 4a67b99 --out-dir validation/v0.6-dev/benchmark-compare [--runs 7] [--tolerance 0.10] [--record benchmarks/results-v0.5.0-baseline-same-machine.json]
//
// Exit 0 when the same-session comparison is OK, 1 when it fails, 3 when the baseline commit cannot be exported.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback }
const commit = option('--commit')
const runs = Number(option('--runs', '7'))
const tolerance = option('--tolerance', '0.10')
const record = option('--record', 'benchmarks/results-v0.5.0-baseline-same-machine.json')
const outDir = option('--out-dir')
if (!commit || !outDir) {
  console.error('usage: benchmark-same-session.mjs --commit <0.5.0 commit> --out-dir <dir> [--runs N] [--tolerance 0.10] [--record <file>]')
  process.exit(2)
}
const out = path.resolve(root, outDir)
mkdirSync(out, { recursive: true })
const relative = file => path.relative(root, file)
const compareScript = path.join(root, 'scripts/benchmark-compare.mjs')
const node = process.execPath

const sh = (command, argv, options = {}) => spawnSync(command, argv, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...options })

// 1. Export the baseline source from git.
const resolved = sh('git', ['rev-parse', '--verify', `${commit}^{commit}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
if (resolved.status !== 0) {
  console.log(`baseline commit ${commit} is not available in this tree (${resolved.stderr.trim() || 'no git history'}); same-session comparison not possible`)
  process.exit(3)
}
const commitFull = resolved.stdout.trim()
const scratch = mkdtempSync(path.join(tmpdir(), 'syna-baseline-'))
const source = path.join(scratch, 'source')
mkdirSync(source, { recursive: true })
let status = 1
try {
  const archive = sh('git', ['archive', '--format=tar', commitFull], { cwd: root, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] })
  if (archive.status !== 0) throw new Error(`git archive failed: ${String(archive.stderr)}`)
  const tarFile = path.join(scratch, 'source.tar')
  writeFileSync(tarFile, archive.stdout)
  const untar = sh('tar', ['-xf', tarFile, '-C', source], { stdio: ['ignore', 'pipe', 'pipe'] })
  if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`)
  console.log(`baseline source: commit ${commitFull} exported to a scratch directory`)

  // 2. Install from its lockfile and build.
  for (const [name, argv] of [['install', ['ci', '--no-fund', '--no-audit']], ['build', ['run', 'build']]]) {
    const result = sh('npm', argv, { cwd: source, stdio: ['ignore', 'pipe', 'pipe'] })
    writeFileSync(path.join(out, `baseline-${name}.log`), `${result.stdout}\n${result.stderr}`)
    if (result.status !== 0) throw new Error(`baseline ${name} failed (exit ${result.status}); see ${relative(path.join(out, `baseline-${name}.log`))}`)
    console.log(`baseline ${name}: ok`)
  }

  // 3. Benchmark the baseline N times and take the element-wise median.
  const baselineRuns = path.join(out, 'baseline-runs')
  rmSync(baselineRuns, { recursive: true, force: true })
  mkdirSync(baselineRuns, { recursive: true })
  const runFiles = []
  for (let index = 1; index <= runs; index += 1) {
    const file = path.join(baselineRuns, `run-${index}.json`)
    const result = sh(node, ['--expose-gc', 'benchmarks/v0.5-planning.mjs', file], { cwd: source, stdio: ['ignore', 'pipe', 'pipe'] })
    if (result.status !== 0) throw new Error(`baseline benchmark run ${index} failed (exit ${result.status}):\n${result.stderr}`)
    runFiles.push(file)
    console.log(`baseline run ${index}/${runs} done`)
  }
  const baselineMedian = path.join(out, 'baseline-v0.5.0-same-session.json')
  const aggregate = sh(node, [compareScript, 'aggregate', ...runFiles.map(relative), '--out', relative(baselineMedian)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  if (aggregate.status !== 0) throw new Error(`aggregate failed: ${aggregate.stderr}`)
  const median = JSON.parse(readFileSync(baselineMedian, 'utf8'))
  writeFileSync(baselineMedian, `${JSON.stringify({ sourceCommit: commitFull, builtFrom: 'git archive of the commit, npm ci, npm run build, in a scratch directory', runs, ...median }, null, 2)}\n`)

  // 4. Benchmark the current tree N times and compare (the table goes to stdout).
  const report = path.join(out, 'same-session.json')
  const compare = sh(node, [compareScript, 'compare', '--baseline', relative(baselineMedian), '--runs', String(runs), '--tolerance', tolerance, '--out', relative(report), '--keep-runs', relative(path.join(out, 'current-runs'))], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  process.stdout.write(compare.stdout)
  if (compare.stderr) process.stderr.write(compare.stderr)
  status = compare.status === 0 ? 0 : 1

  // 5. Informational: how far this session's 0.5.0 sits from the recorded 0.5.0 file (machine drift, not code).
  if (existsSync(path.resolve(root, record))) {
    const driftFile = path.join(out, 'record-drift.json')
    const drift = sh(node, [compareScript, 'compare', '--baseline', record, '--current', relative(baselineMedian), '--tolerance', tolerance, '--out', relative(driftFile)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    const summary = drift.stdout.split('\n').find(line => line.startsWith('equality checks:')) ?? ''
    console.log(`record drift (informational): this session's 0.5.0 vs ${record}: ${summary || `exit ${drift.status}`}`)
  }
}
catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  status = 1
}
finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(status === 0 ? 'SAME-SESSION BENCHMARK COMPARISON OK' : 'SAME-SESSION BENCHMARK COMPARISON FAILED')
process.exit(status)

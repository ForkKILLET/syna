#!/usr/bin/env node
// Same-session benchmark comparison with the previous release (0.6 compared with 0.5.0, 0.7 with 0.6.0). The
// baseline source is exported from its git commit into a scratch directory, installed from its lockfile and built;
// then both it and the current tree are benchmarked in
// the same session: one discarded warm-up run per side, then N rounds that run both sides in alternating order.
// Each side's element-wise median over the N runs is compared by scripts/benchmark-compare.mjs (every p50/p95/
// per-operation value within ±tolerance, every plan-cache counter and shape count equal). Measuring both sides in
// one session, interleaved, removes the machine-state drift a recorded baseline file carries (thermal state,
// background load, OS updates) and keeps a slow period of the machine from landing on one side only; the recorded
// baseline file is compared with this session's baseline as well and reported as `recordDrift` (informational; it
// says how far the machine moved, not how the code did).
//
//   node scripts/benchmark-same-session.mjs --commit 582c93a --baseline-label 0.6.0 --out-dir validation/v0.7-dev/benchmark-compare [--runs 21] [--tolerance 0.10] [--record benchmarks/results-v0.6.0-baseline-same-machine.json]
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
const runs = Number(option('--runs', '21'))
const tolerance = option('--tolerance', '0.10')
const record = option('--record', 'benchmarks/results-v0.5.0-baseline-same-machine.json')
const label = option('--baseline-label', '0.5.0')
const outDir = option('--out-dir')
if (!commit || !outDir) {
  console.error('usage: benchmark-same-session.mjs --commit <baseline commit> --out-dir <dir> [--baseline-label 0.5.0] [--runs N] [--tolerance 0.10] [--record <file>]')
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

  // 3. One discarded warm-up run per side: file caches and JIT state after the fresh install and build.
  const workload = 'benchmarks/v0.5-planning.mjs'
  const sides = [
    { name: 'baseline', cwd: source, dir: path.join(out, 'baseline-runs'), files: [] },
    { name: 'current', cwd: root, dir: path.join(out, 'current-runs'), files: [] },
  ]
  const benchmark = (side, file) => {
    const result = sh(node, ['--expose-gc', workload, file], { cwd: side.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    if (result.status !== 0) throw new Error(`${side.name} benchmark run failed (exit ${result.status}):\n${result.stderr}`)
  }
  for (const side of sides) {
    rmSync(side.dir, { recursive: true, force: true })
    mkdirSync(side.dir, { recursive: true })
    benchmark(side, path.join(scratch, `warm-up-${side.name}.json`))
    console.log(`${side.name} warm-up run done (discarded)`)
  }

  // 4. N rounds with both sides in every round, the order alternating (baseline first in odd rounds, current first
  //    in even rounds), so a slow period of the machine lands on both sides alike; a p95 of a sub-millisecond
  //    operation is bimodal from run to run, and the element-wise median over N runs per side is what gets compared.
  for (let round = 1; round <= runs; round += 1) {
    const order = round % 2 === 1 ? sides : [...sides].reverse()
    for (const side of order) {
      const file = path.join(side.dir, `run-${round}.json`)
      benchmark(side, file)
      side.files.push(file)
    }
    console.log(`round ${round}/${runs} done (${order.map(side => side.name).join(', then ')})`)
  }
  const method = { runs, warmUpRuns: 1, order: 'alternating rounds, both sides in every round' }
  const medianOf = (side, file, extra) => {
    const aggregate = sh(node, [compareScript, 'aggregate', ...side.files.map(relative), '--out', relative(file)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    if (aggregate.status !== 0) throw new Error(`aggregate of the ${side.name} runs failed: ${aggregate.stderr}`)
    const median = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, `${JSON.stringify({ ...extra, ...method, ...median }, null, 2)}\n`)
  }
  const baselineMedian = path.join(out, `baseline-v${label}-same-session.json`)
  const currentMedian = path.join(out, 'current-same-session.json')
  medianOf(sides[0], baselineMedian, { sourceCommit: commitFull, builtFrom: 'git archive of the commit, npm ci, npm run build, in a scratch directory' })
  medianOf(sides[1], currentMedian, { source: 'the current working tree' })

  // 5. Compare the two medians (the table goes to stdout).
  const report = path.join(out, 'same-session.json')
  const compare = sh(node, [compareScript, 'compare', '--baseline', relative(baselineMedian), '--current', relative(currentMedian), '--tolerance', tolerance, '--out', relative(report)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  process.stdout.write(compare.stdout)
  if (compare.stderr) process.stderr.write(compare.stderr)
  status = compare.status === 0 ? 0 : 1

  // 6. Informational: how far this session's baseline sits from the recorded baseline file (machine drift, not code).
  if (existsSync(path.resolve(root, record))) {
    const driftFile = path.join(out, 'record-drift.json')
    const drift = sh(node, [compareScript, 'compare', '--baseline', record, '--current', relative(baselineMedian), '--tolerance', tolerance, '--out', relative(driftFile)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    const summary = drift.stdout.split('\n').find(line => line.startsWith('equality checks:')) ?? ''
    console.log(`record drift (informational): this session's ${label} vs ${record}: ${summary || `exit ${drift.status}`}`)
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

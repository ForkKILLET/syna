#!/usr/bin/env node
// Same-machine benchmark comparison for the v0.5 planning workload (benchmarks/v0.5-planning.mjs).
//
//   node scripts/benchmark-compare.mjs aggregate <run.json>... --out <median.json>
//       Element-wise median of several runs of the workload (every numeric leaf; integers stay integers).
//   node scripts/benchmark-compare.mjs compare --baseline <median.json> (--runs N | --current <median.json>) [--out <report.json>] [--tolerance 0.10] [--keep-runs <dir>]
//       Runs the workload N times (default 7), aggregates, and compares against the baseline:
//       every p50Ms/p95Ms and perOperationMs must be within ±tolerance of the baseline value,
//       every plan-cache counter and shape count must be equal, and the environment must match
//       (node major, platform, arch, cpu) — otherwise the comparison is reported as not comparable and fails.
//       Exit code 0 only when every checked value passes.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workload = path.join(root, 'benchmarks/v0.5-planning.mjs')
const args = process.argv.slice(2)
const mode = args[0]
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const positionals = args.slice(1).filter((argument, index, list) => !argument.startsWith('--') && !(index > 0 && list[index - 1].startsWith('--')))

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const result = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  return values.every(Number.isInteger) ? Math.round(result) : result
}

// Element-wise median: arrays are aligned by index (cases by name), objects by key; non-numeric leaves come from the first run.
const aggregate = runs => {
  const merge = values => {
    const first = values[0]
    if (typeof first === 'number') return median(values)
    if (Array.isArray(first)) {
      if (first.length > 0 && isPlainObject(first[0]) && typeof first[0].name === 'string') {
        return first.map(item => merge(values.map(run => run.find(candidate => candidate.name === item.name) ?? item)))
      }
      return first.map((item, index) => merge(values.map(run => run[index] ?? item)))
    }
    if (isPlainObject(first)) {
      const out = {}
      for (const key of Object.keys(first)) out[key] = merge(values.map(run => run?.[key] ?? first[key]))
      return out
    }
    return first
  }
  const merged = merge(runs)
  merged.methodology = { ...(merged.methodology ?? {}), aggregation: `element-wise median of ${runs.length} runs of benchmarks/v0.5-planning.mjs`, runs: runs.length }
  merged.generatedAt = runs.map(run => run.generatedAt).sort()[runs.length - 1]
  return merged
}

const TOLERANCE_KEYS = new Set(['p50Ms', 'p95Ms', 'perOperationMs'])
// `inherited` is the benchmark's own top-level key of two cases (kept as it is); the counts and the plan-cache record are normalized below.
const EQUAL_KEYS = new Set(['hits', 'misses', 'entries', 'evictions', 'limit', 'planCacheEntries', 'planCacheEntriesMax', 'liveEnvCountAfter', 'inherited', 'reused', 'new', 'forked', 'eagerToStart', 'eagerReused', 'provided', 'newServices', 'serviceCount', 'depth', 'operations', 'generatedEntryShapes', 'samples', 'warmup'])

// v0.8 (the last rename): the benchmark spreads `explanation.services` and `inspect().planCache` into its records, so a
// record written before 0.8 spells the counts and the plan-cache capacity under the pre-0.8 keys. Both sides of every
// comparison are read in the 0.8 spelling — the only key rename of the record format; no number changes. The record's
// own top-level `inherited` (two cases) is the benchmark's name, not Syna's, and stays.
const RECORD_KEY_RENAMES = [
  { key: 'maxEntries', to: 'limit', within: keys => keys.includes('hits') && keys.includes('misses') }, // syna-v08-rename
  { key: 'eagerInherited', to: 'eagerReused', within: () => true }, // syna-v08-rename
  { key: 'inherited', to: 'reused', within: keys => keys.includes('eagerToStart') || keys.includes('eagerReused') || keys.includes('eagerInherited') || (keys.includes('new') && keys.includes('forked')) }, // syna-v08-rename
]
const normalizeRecord = value => {
  if (Array.isArray(value)) return value.map(normalizeRecord)
  if (!isPlainObject(value)) return value
  const keys = Object.keys(value)
  const out = {}
  for (const [key, inner] of Object.entries(value)) {
    const rename = RECORD_KEY_RENAMES.find(entry => entry.key === key && entry.within(keys))
    out[rename ? rename.to : key] = normalizeRecord(inner)
  }
  return out
}
const ENVIRONMENT_KEYS = ['platform', 'arch', 'cpu', 'cpuCount']

const compare = (baselineRecord, currentRecord, tolerance) => {
  const baseline = normalizeRecord(baselineRecord)
  const current = normalizeRecord(currentRecord)
  const rows = []
  const walk = (base, cur, trail) => {
    if (isPlainObject(base)) {
      for (const key of Object.keys(base)) {
        const next = trail.concat(key)
        if (typeof base[key] === 'number' && TOLERANCE_KEYS.has(key)) {
          const ratio = base[key] === 0 ? (cur?.[key] === 0 ? 0 : Infinity) : cur?.[key] / base[key] - 1
          rows.push({ path: next.join('.'), check: `±${Math.round(tolerance * 100)}%`, baseline: base[key], current: cur?.[key], delta: ratio, ok: Number.isFinite(ratio) && Math.abs(ratio) <= tolerance })
        } else if (typeof base[key] === 'number' && EQUAL_KEYS.has(key)) {
          rows.push({ path: next.join('.'), check: 'equal', baseline: base[key], current: cur?.[key], delta: cur?.[key] === base[key] ? 0 : null, ok: cur?.[key] === base[key] })
        } else if (isPlainObject(base[key]) || Array.isArray(base[key])) {
          walk(base[key], cur?.[key], next)
        }
      }
    } else if (Array.isArray(base)) {
      base.forEach((item, index) => {
        if (isPlainObject(item) && typeof item.name === 'string') {
          const match = Array.isArray(cur) ? cur.find(candidate => candidate?.name === item.name) : undefined
          if (!match) rows.push({ path: trail.concat(item.name).join('.'), check: 'present', baseline: item.name, current: undefined, delta: null, ok: false })
          else walk(item, match, trail.concat(item.name))
        } else if (item !== null && typeof item === 'object') walk(item, cur?.[index], trail.concat(String(index)))
      })
    }
  }
  walk({ cases: baseline.cases }, { cases: current.cases }, [])
  const environment = ENVIRONMENT_KEYS.map(key => ({ key, baseline: baseline.environment?.[key], current: current.environment?.[key], ok: baseline.environment?.[key] === current.environment?.[key] }))
  const nodeMajor = version => String(version ?? '').split('.')[0]
  environment.push({ key: 'node (major)', baseline: nodeMajor(baseline.environment?.node), current: nodeMajor(current.environment?.node), ok: nodeMajor(baseline.environment?.node) === nodeMajor(current.environment?.node) })
  const comparable = environment.every(row => row.ok)
  return { comparable, environment, rows, ok: comparable && rows.every(row => row.ok) }
}

const runWorkload = (count, keepDir) => {
  const dir = keepDir ? path.resolve(root, keepDir) : mkdtempSync(path.join(tmpdir(), 'syna-benchmark-'))
  mkdirSync(dir, { recursive: true })
  const runs = []
  for (let index = 1; index <= count; index += 1) {
    const file = path.join(dir, `run-${index}.json`)
    const result = spawnSync(process.execPath, ['--expose-gc', workload, file], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (result.status !== 0) throw new Error(`benchmark run ${index} failed (exit ${result.status}):\n${result.stderr}`)
    runs.push(JSON.parse(readFileSync(file, 'utf8')))
    process.stderr.write(`benchmark run ${index}/${count} done\n`)
  }
  if (!keepDir) rmSync(dir, { recursive: true, force: true })
  return runs
}

const format = value => typeof value === 'number' ? (Number.isInteger(value) ? String(value) : value.toFixed(4)) : String(value)

const write = (file, content) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(content, null, 2) + '\n')
}

if (mode === 'aggregate') {
  const files = positionals
  if (files.length === 0) throw new Error('aggregate needs at least one run file')
  const runs = files.map(file => JSON.parse(readFileSync(path.resolve(root, file), 'utf8')))
  const merged = aggregate(runs)
  const out = option('--out')
  if (out) { write(path.resolve(root, out), merged); console.log(`wrote ${out} (median of ${runs.length} runs)`) } else console.log(JSON.stringify(merged, null, 2))
} else if (mode === 'compare') {
  const baselineFile = option('--baseline')
  if (!baselineFile) throw new Error('compare needs --baseline <median.json>')
  const baseline = JSON.parse(readFileSync(path.resolve(root, baselineFile), 'utf8'))
  const tolerance = Number(option('--tolerance', '0.10'))
  const currentFile = option('--current')
  const runs = currentFile ? undefined : Number(option('--runs', '7'))
  const current = currentFile ? JSON.parse(readFileSync(path.resolve(root, currentFile), 'utf8')) : aggregate(runWorkload(runs, option('--keep-runs')))
  const report = compare(baseline, current, tolerance)
  const output = { baseline: baselineFile, current: currentFile ?? `median of ${runs} fresh runs`, tolerance, ...report, currentResult: current }
  const out = option('--out')
  if (out) write(path.resolve(root, out), output)
  console.log(`environment ${report.comparable ? 'matches' : 'DIFFERS'}: ${report.environment.map(row => `${row.key}=${row.current}${row.ok ? '' : ` (baseline ${row.baseline})`}`).join(', ')}`)
  console.log('| value | check | baseline | current | delta | ok |')
  console.log('|---|---|---|---|---|---|')
  for (const row of report.rows) {
    if (row.check === 'equal' && row.ok) continue
    console.log(`| ${row.path} | ${row.check} | ${format(row.baseline)} | ${format(row.current)} | ${row.delta === null ? '—' : `${(row.delta * 100).toFixed(1)}%`} | ${row.ok ? 'yes' : 'NO'} |`)
  }
  const equal = report.rows.filter(row => row.check === 'equal')
  console.log(`equality checks: ${equal.filter(row => row.ok).length}/${equal.length} equal; tolerance checks: ${report.rows.filter(row => row.check !== 'equal' && row.ok).length}/${report.rows.filter(row => row.check !== 'equal').length} within ±${Math.round(tolerance * 100)}%`)
  console.log(report.ok ? 'BENCHMARK COMPARISON OK' : 'BENCHMARK COMPARISON FAILED')
  if (out) console.log(`wrote ${out}`)
  process.exit(report.ok ? 0 : 1)
} else {
  console.error('usage: benchmark-compare.mjs aggregate <run.json>... --out <file> | compare --baseline <file> [--runs N | --current <file>] [--out <report>] [--tolerance 0.10]')
  process.exit(2)
}

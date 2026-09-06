// Syna v0.5 planning/materialization micro-benchmarks (P01–P04).
// Usage: node --expose-gc benchmarks/v0.5-planning.mjs [output.json] [--quick]
import { writeFile } from 'node:fs/promises'
import { cpus, platform, release, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auto, createRuntime, definePackage, forward, override } from '../packages/core/dist/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const quick = process.argv.includes('--quick')
const scale = quick ? 0.2 : 1
const iterations = base => Math.max(20, Math.round(base * scale))

const percentile = (sorted, fraction) => {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index]
}
const summarize = samples => {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    samples: sorted.length,
    minMs: sorted[0],
    p50Ms: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1),
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  }
}
const forceGc = () => { if (typeof globalThis.gc === 'function') for (let i = 0; i < 3; i += 1) globalThis.gc() }
const heap = () => { forceGc(); return process.memoryUsage().heapUsed }

async function timed(count, warmup, invoke) {
  for (let index = 0; index < warmup; index += 1) await invoke(`w${index}`)
  const heapBefore = heap()
  const samples = []
  for (let index = 0; index < count; index += 1) {
    const started = performance.now()
    await invoke(index)
    samples.push(performance.now() - started)
  }
  return { timing: summarize(samples), warmup, heapDeltaBytes: heap() - heapBefore }
}

function pkg(id, version = '1.0.0') {
  return definePackage({ name: `@bench/${id}`, version, syna: { id: `bench.${id}` } })
}

/** A representative graph: a stable core (pools, loggers, factories) plus request-local chains. */
function representativeWorld(serviceCount, options = {}) {
  const define = pkg(`world-${serviceCount}-${options.tag ?? 'plain'}`)
  const CurrentRequest = define.input('current-request')
  const Tenant = define.input('tenant')
  const Capability = define.contract('capability')
  const Choice = define.binding('choice', Capability)
  const Logger = define.service('logger', { setup: () => ({}) })
  const Pool = define.service('pool', { requires: { logger: Logger }, setup: () => ({}) })
  const providers = [1, 2, 3].map(index => pkg(`world-${serviceCount}-provider${index}`).service({ provides: [Capability], requires: { pool: Pool }, setup: () => ({}) }))
  const factories = Array.from({ length: 12 }, (_, index) => define.service(`factory-${index}`, { provides: [Capability], setup: () => ({}) }))
  const stable = []
  for (let index = 0; index < Math.floor(serviceCount * 0.6); index += 1) {
    const previous = stable.at(-1)
    stable.push(define.service(`stable-${index}`, {
      requires: { pool: Pool, ...(previous ? { previous } : {}), ...(index % 5 === 0 ? { all: Capability.all } : {}), ...(index % 7 === 0 ? { choice: Choice } : {}) },
      setup: () => ({}),
    }))
  }
  const tenantScoped = []
  for (let index = 0; index < Math.floor(serviceCount * 0.2); index += 1) {
    tenantScoped.push(define.service(`tenant-${index}`, {
      requires: { tenant: Tenant, stable: stable[index % stable.length], ...(index % 3 === 0 ? { automatic: auto(Capability) } : {}) },
      setup: () => ({}),
    }))
  }
  const requestScoped = []
  for (let index = 0; index < serviceCount - stable.length - tenantScoped.length; index += 1) {
    const previous = requestScoped.at(-1)
    requestScoped.push(define.service(`request-${index}`, {
      requires: { request: CurrentRequest, tenant: tenantScoped[index % tenantScoped.length], ...(previous ? { previous } : {}) },
      setup: () => ({}),
    }))
  }
  let A
  let B
  A = define.service('scc-a', { requires: { b: forward(() => B), pool: Pool }, setup: () => ({}) })
  B = define.service('scc-b', { requires: { a: forward(() => A) }, setup: () => ({}) })
  const TxEntry = define.entry('tx', { requires: { tx: define.service('tx', { requires: { pool: Pool }, setup: () => ({}) }) } })
  const UnitOfWork = define.service('uow', { requires: { tx: TxEntry }, setup: ({ tx }) => ({ tx }) })

  const App = define.entry('app', { requires: { pool: Pool, uow: UnitOfWork, a: A, ...Object.fromEntries(stable.map((s, i) => [`s${i}`, s])) }, parameters: { choice: Choice } })
  const Layer = define.entry('layer', {})
  const Site = define.entry('site', { requires: Object.fromEntries(tenantScoped.map((s, i) => [`t${i}`, s])), parameters: { tenant: Tenant } })
  const Request = define.entry('request', { requires: { handler: requestScoped.at(-1) ?? stable[0] }, parameters: { request: CurrentRequest } })
  const services = [Pool, Logger, ...providers, ...factories, ...stable, ...tenantScoped, ...requestScoped, A, B, UnitOfWork]
  return { define, CurrentRequest, Tenant, Capability, Choice, Pool, providers, factories, stable, tenantScoped, requestScoped, A, B, UnitOfWork, App, Layer, Site, Request, services }
}

async function warmEnterDisposeCase(serviceCount, depth) {
  const world = representativeWorld(serviceCount, { tag: `d${depth}` })
  const runtime = createRuntime({ services: world.services, limits: { planCacheEntries: 64 }, policy: { orderAutoCandidates: (_c, candidates) => candidates } })
  const coldStart = performance.now()
  const app = await runtime.enter(world.App, { choice: Choice(world) })
  const coldPlanMs = performance.now() - coldStart
  let anchor = app
  for (let index = 1; index < depth; index += 1) anchor = await anchor.enter(world.Layer)
  const site = await anchor.enter(world.Site, { tenant: 'bench' })
  const result = await timed(iterations(500), 50, async id => {
    const env = await site.enter(world.Request, { request: { id } })
    await env.dispose()
  })
  const explanation = await site.explain(world.Request, { request: { id: 'x' } })
  const inspection = runtime.inspect()
  await runtime.dispose()
  return {
    name: `warm-enter-dispose-${serviceCount}-depth-${depth}`,
    serviceCount, depth,
    coldPlanMs,
    requestShape: { services: explanation.services, inputs: explanation.inputs, synthetic: explanation.synthetic },
    ...result,
    planCache: inspection.planCache,
  }
}
const Choice = world => world.Choice.to(world.providers[0])

async function phaseBreakdownCase(serviceCount) {
  const world = representativeWorld(serviceCount, { tag: 'phases' })
  const cold = [], warm = [], materialize = [], dispose = []
  for (let round = 0; round < iterations(60); round += 1) {
    const runtime = createRuntime({ services: world.services, limits: { planCacheEntries: 64 }, policy: { orderAutoCandidates: (_c, candidates) => candidates } })
    let started = performance.now()
    const app = await runtime.enter(world.App, { choice: Choice(world) })
    const site = await app.enter(world.Site, { tenant: 't' })
    const first = await site.enter(world.Request, { request: { id: 1 } })
    cold.push(performance.now() - started)
    await first.dispose()
    started = performance.now()
    const second = await site.enter(world.Request, { request: { id: 2 } })
    warm.push(performance.now() - started)
    started = performance.now()
    await second.deps.handler.load()
    materialize.push(performance.now() - started)
    started = performance.now()
    await second.dispose()
    dispose.push(performance.now() - started)
    await runtime.dispose()
  }
  return {
    name: `phase-breakdown-${serviceCount}`,
    serviceCount,
    coldPlanWithNewSlotsMs: summarize(cold),
    warmPlanMs: summarize(warm),
    materializationMs: summarize(materialize),
    disposeMs: summarize(dispose),
  }
}

async function inputClosureCase() {
  const world = representativeWorld(200, { tag: 'closure' })
  const runtime = createRuntime({ services: world.services, limits: { planCacheEntries: 64 }, policy: { orderAutoCandidates: (_c, candidates) => candidates } })
  const app = await runtime.enter(world.App, { choice: Choice(world) })
  const siteA = await app.enter(world.Site, { tenant: 'a' })
  const explanation = await app.explain(world.Site, { tenant: 'b' })
  const result = await timed(iterations(300), 20, async id => {
    const site = await app.enter(world.Site, { tenant: `t${id}` })
    await site.dispose()
  })
  await siteA.dispose()
  const inspection = runtime.inspect()
  await runtime.dispose()
  return { name: 'site-enter-tenant-input-reverse-closure-200', forked: explanation.services.forked, inherited: explanation.services.inherited, ...result, planCache: inspection.planCache }
}

/**
 * A Service-owned AnchoredEntry (the Hyla UnitOfWork / request-handler pattern): the
 * private Entry selects a helper by range inside the owner's private realm and
 * carries a full request chain, so every timed enter plans ~20 request-scoped
 * services under ~80 inherited ones — not a one-node graph.
 */
async function privateRangeAndAnchoredEntryCase() {
  const world = representativeWorld(100, { tag: 'bound' })
  const define = world.define
  const Private = define.service('private-helper', { setup: () => ({}) })
  const PrivateEntry = define.entry('private-entry', {
    requires: { helper: Private.range('^1'), handler: world.requestScoped.at(-1) },
    parameters: { request: world.CurrentRequest },
  })
  // A range selects among revisions the Runtime knows: admitted, the owner's exact
  // closure, or (third review round) the range's own origin. The helper is referenced
  // by range only.
  const Owner = define.service('owner', { requires: { entry: PrivateEntry }, setup: ({ entry }) => ({ entry }) })
  const OwnerLayer = define.entry('owner-layer', { requires: { owner: Owner } })
  const runtime = createRuntime({ services: [...world.services, Owner], limits: { planCacheEntries: 64 }, policy: { orderAutoCandidates: (_c, candidates) => candidates } })
  const app = await runtime.enter(world.App, { choice: Choice(world) })
  const site = await app.enter(world.Site, { tenant: 'bound' })
  const ownerEnv = await site.enter(OwnerLayer)
  const owner = await ownerEnv.deps.owner.load()
  const bound = await owner.entry.load()
  const explanation = await bound.explain({ request: { id: 'explain' } })
  const result = await timed(iterations(500), 50, async id => {
    const env = await bound.enter({ request: { id } })
    await env.dispose()
  })
  const planCache = runtime.inspect().planCache
  await runtime.dispose()
  return { name: 'bound-entry-private-range-request-enter-dispose-100', inherited: explanation.services.inherited, newServices: explanation.services.new, ...result, planCache }
}

async function overrideAndAllCase() {
  const world = representativeWorld(100, { tag: 'override' })
  const define = world.define
  const FakePool = define.service('fake-pool', { setup: () => ({}) })
  const runtime = createRuntime({ services: world.services, overrides: [override(world.Pool, FakePool)], limits: { planCacheEntries: 64 }, policy: { orderAutoCandidates: (_c, candidates) => candidates } })
  const app = await runtime.enter(world.App, { choice: Choice(world) })
  const site = await app.enter(world.Site, { tenant: 'o' })
  const result = await timed(iterations(500), 50, async id => {
    const env = await site.enter(world.Request, { request: { id } })
    await env.dispose()
  })
  await runtime.dispose()
  return { name: 'override-and-all-request-enter-dispose-100', ...result }
}

async function churnCase() {
  const world = representativeWorld(100, { tag: 'churn' })
  const runtime = createRuntime({ services: world.services, limits: { planCacheEntries: 64 }, policy: { orderAutoCandidates: (_c, candidates) => candidates } })
  const app = await runtime.enter(world.App, { choice: Choice(world) })
  const site = await app.enter(world.Site, { tenant: 'churn' })
  const uow = await app.deps.uow.load()
  const total = iterations(10_000)
  const heapSamples = []
  let planCacheEntriesMax = 0
  const started = performance.now()
  for (let index = 0; index < total; index += 1) {
    if (index % 3 === 0) {
      const bound = await uow.tx.load()
      const env = await bound.enter()
      await env.dispose()
    }
    else {
      const env = await site.enter(world.Request, { request: { id: index } })
      if (index % 4 === 1) await env.deps.handler.load()
      await env.dispose()
    }
    const stats = runtime.inspect().planCache
    planCacheEntriesMax = Math.max(planCacheEntriesMax, stats.entries)
    if (index % Math.floor(total / 5) === 0) heapSamples.push({ index, heapUsed: heap(), liveEnvs: runtime.inspect().liveEnvCount })
  }
  const elapsedMs = performance.now() - started
  const inspection = runtime.inspect()
  await runtime.dispose()
  return {
    name: 'churn-10000-requests',
    operations: total,
    elapsedMs,
    perOperationMs: elapsedMs / total,
    planCacheEntriesMax,
    liveEnvCountAfter: inspection.liveEnvCount,
    planCache: inspection.planCache,
    heapSamples,
  }
}

async function lruChurnCase() {
  const define = pkg('lru-churn')
  const Service = define.service({ setup: () => ({}) })
  const runtime = createRuntime({ services: [Service], limits: { planCacheEntries: 16 } })
  const shapes = iterations(500)
  for (let index = 0; index < shapes; index += 1) {
    const Entry = define.entry(`entry-${index}`, { requires: { service: Service } })
    const env = await runtime.enter(Entry)
    await env.dispose()
  }
  const inspection = runtime.inspect()
  await runtime.dispose()
  return { name: 'lru-churn-500-shapes', generatedEntryShapes: shapes, planCacheEntries: inspection.planCache.entries, planCache: inspection.planCache }
}

const cases = [
  await warmEnterDisposeCase(100, 2),
  await warmEnterDisposeCase(100, 6),
  await warmEnterDisposeCase(300, 2),
  await warmEnterDisposeCase(300, 6),
  await phaseBreakdownCase(300),
  await inputClosureCase(),
  await privateRangeAndAnchoredEntryCase(),
  await overrideAndAllCase(),
  await churnCase(),
  await lruChurnCase(),
]

const budgets = JSON.parse(readFileSync(path.join(here, 'budgets.json'), 'utf8'))
const budgetResults = Object.entries(budgets.cases).map(([name, budget]) => {
  const caseName = name.replace(/-liveEnvs$/, '')
  const item = cases.find(candidate => candidate.name === caseName)
  const value = item ? (budget.metric in item ? item[budget.metric] : item.timing?.[budget.metric]) : undefined
  return { budget: name, metric: budget.metric, max: budget.max, value, ok: typeof value === 'number' && value <= budget.max }
})

const corePackage = JSON.parse(readFileSync(path.join(here, '..', 'packages', 'core', 'package.json'), 'utf8'))
const result = {
  generatedAt: new Date().toISOString(),
  quick,
  environment: {
    node: process.version,
    v8: process.versions.v8,
    platform: platform(),
    release: release(),
    arch: process.arch,
    cpu: cpus()[0]?.model,
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    gcExposed: typeof globalThis.gc === 'function',
    nodeOptions: process.execArgv,
  },
  core: { name: corePackage.name, version: corePackage.version },
  methodology: {
    note: 'Setups are empty and involve no network. Warm cases measure enter+dispose of a sibling Entry with a cached plan template; percentiles are over individual iterations after warmup. Numbers are machine-specific; cache cardinality and bounded growth are the portable assertions.',
    warmupIterations: 50,
  },
  budgets: budgetResults,
  budgetsOk: budgetResults.every(item => item.ok),
  cases,
}

const output = process.argv.slice(2).find(argument => !argument.startsWith('--'))
if (output) await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ budgets: result.budgets, budgetsOk: result.budgetsOk, cases: cases.map(item => ({ name: item.name, p95Ms: item.timing?.p95Ms, planCache: item.planCache?.entries })) }, null, 2))
if (!result.budgetsOk) process.exitCode = 3

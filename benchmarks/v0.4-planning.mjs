import { writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { createRuntime, definePackage } from '../packages/core/dist/index.js'

const percentile = (sorted, fraction) => {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index]
}

const summarize = samples => {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    minMs: sorted[0],
    p50Ms: percentile(sorted, 0.50),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1),
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  }
}

const forceGc = () => {
  if (typeof globalThis.gc === 'function') {
    for (let index = 0; index < 3; index += 1) globalThis.gc()
  }
}

async function sample(iterations, warmup, invoke) {
  for (let index = 0; index < warmup; index += 1) await invoke(`warmup-${index}`)
  forceGc()
  const heapBefore = process.memoryUsage().heapUsed
  const samples = []
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now()
    await invoke(index)
    samples.push(performance.now() - started)
  }
  forceGc()
  const heapAfter = process.memoryUsage().heapUsed
  return {
    iterations,
    timing: summarize(samples),
    heapDeltaBytes: heapAfter - heapBefore,
  }
}

async function requestChainCase(serviceCount, depth) {
  const define = definePackage({
    name: `@benchmark/request-chain-${serviceCount}-${depth}`,
    version: '1.0.0',
    syna: { id: `benchmark.request-chain-${serviceCount}-${depth}` },
  })
  const CurrentRequest = define.input('current-request')
  const Stable = define.service('stable', { setup: () => ({ id: 'stable' }) })
  const services = []
  for (let index = 0; index < serviceCount; index += 1) {
    const previous = services.at(-1)
    services.push(define.service(`request-${index}`, {
      requires: {
        request: CurrentRequest,
        stable: Stable,
        ...(previous ? { previous } : {}),
      },
      setup: () => ({ index }),
    }))
  }
  const Root = define.entry('root', { requires: { stable: Stable } })
  const Layer = define.entry('layer', {})
  const Request = define.entry('request', {
    requires: { handler: services.at(-1) },
    parameters: { request: CurrentRequest },
  })
  const runtime = createRuntime({ services: [Stable, services.at(-1)], planCache: { maxEntries: 64 } })
  let anchor = await runtime.enter(Root)
  for (let index = 1; index < depth; index += 1) anchor = await anchor.enter(Layer)
  const result = await sample(500, 50, async id => {
    const env = await anchor.enter(Request, { request: { id } })
    await env.dispose()
  })
  const inspection = runtime.inspect()
  await runtime.dispose()
  return {
    name: `request-chain-${serviceCount}-depth-${depth}`,
    serviceCount,
    depth,
    ...result,
    planCache: inspection.planCache,
  }
}

async function selectorCase() {
  const define = definePackage({
    name: '@benchmark/selector-request',
    version: '1.0.0',
    syna: { id: 'benchmark.selector-request' },
  })
  const CurrentRequest = define.input('current-request')
  const Provider = define.contract('provider')
  const providers = ['alpha', 'beta', 'gamma'].map(name => define.service(name, {
    provides: [Provider],
    setup: () => ({ name }),
  }))
  const Panel = define.service('panel', {
    requires: { request: CurrentRequest, providers: Provider.selector },
    setup: () => ({ ready: true }),
  })
  const Root = define.entry('root', {})
  const Request = define.entry('request', {
    requires: { panel: Panel },
    parameters: { request: CurrentRequest },
  })
  const runtime = createRuntime({ services: [Panel, ...providers], planCache: { maxEntries: 32 } })
  const root = await runtime.enter(Root)
  const result = await sample(1000, 100, async id => {
    const env = await root.enter(Request, { request: { id } })
    await env.dispose()
  })
  const inspection = runtime.inspect()
  await runtime.dispose()
  return {
    name: 'selector-request-3-candidates',
    candidateCount: providers.length,
    ...result,
    planCache: inspection.planCache,
  }
}

async function bindingCase() {
  const define = definePackage({
    name: '@benchmark/binding-request',
    version: '1.0.0',
    syna: { id: 'benchmark.binding-request' },
  })
  const CurrentRequest = define.input('current-request')
  const Provider = define.contract('provider')
  const Choice = define.binding('provider-choice', Provider)
  const Alpha = define.service('alpha', { provides: [Provider], setup: () => ({ name: 'alpha' }) })
  const Beta = define.service('beta', { provides: [Provider], setup: () => ({ name: 'beta' }) })
  const Consumer = define.service('consumer', {
    requires: { request: CurrentRequest, provider: Choice },
    setup: () => ({ ready: true }),
  })
  const Root = define.entry('root', {})
  const Request = define.entry('request', {
    requires: { consumer: Consumer },
    parameters: { request: CurrentRequest, provider: Choice },
  })
  const runtime = createRuntime({ services: [Consumer, Alpha, Beta], planCache: { maxEntries: 32 } })
  const root = await runtime.enter(Root)
  const alpha = Choice.to(Alpha)
  const beta = Choice.to(Beta)
  const result = await sample(1000, 100, async id => {
    const env = await root.enter(Request, {
      request: { id },
      provider: Number(id) % 2 === 0 ? alpha : beta,
    })
    await env.dispose()
  })
  const inspection = runtime.inspect()
  await runtime.dispose()
  return {
    name: 'binding-request-2-choices',
    choiceCount: 2,
    ...result,
    planCache: inspection.planCache,
  }
}

async function lruChurnCase() {
  const define = definePackage({
    name: '@benchmark/lru-churn',
    version: '1.0.0',
    syna: { id: 'benchmark.lru-churn' },
  })
  const Service = define.service({ setup: () => ({}) })
  const runtime = createRuntime({ services: [Service], planCache: { maxEntries: 16 } })
  for (let index = 0; index < 500; index += 1) {
    const Entry = define.entry(`entry-${index}`, { requires: { service: Service } })
    const env = await runtime.enter(Entry)
    await env.dispose()
  }
  const inspection = runtime.inspect()
  await runtime.dispose()
  return {
    name: 'bounded-lru-entry-shape-churn',
    generatedEntryShapes: 500,
    planCache: inspection.planCache,
  }
}

const cases = [
  await requestChainCase(100, 2),
  await requestChainCase(100, 6),
  await requestChainCase(300, 2),
  await requestChainCase(300, 6),
  await selectorCase(),
  await bindingCase(),
  await lruChurnCase(),
]

const result = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuCount: cpus().length,
    gcExposed: typeof globalThis.gc === 'function',
  },
  methodology: {
    warmSiblingEntry: 'enter + dispose; no explicit Service materialization',
    requestIterations: 500,
    selectorAndBindingIterations: 1000,
    note: 'Numbers are machine-specific; cache cardinality and non-linear growth checks are the portable assertions.',
  },
  cases,
}

const output = process.argv[2]
if (output) await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(result, null, 2))

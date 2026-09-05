import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { createRuntime, definePackage } from '../packages/core/dist/index.js'

const percentile = (sorted, p) => {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[index]
}

async function runCase({ serviceCount, depth, iterations = 250, warmup = 25 }) {
  const define = definePackage({
    name: `@benchmark/request-${serviceCount}-${depth}`,
    version: '1.0.0',
    syna: { id: `benchmark.request-${serviceCount}-${depth}` },
  })
  const CurrentRequest = define.input('current-request')

  const Stable = define.service('stable', { setup: () => ({ id: 'stable' }) })
  const services = []
  for (let index = 0; index < serviceCount; index += 1) {
    const previous = services[index - 1]
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

  const runtime = createRuntime({ services: [Stable, services.at(-1)] })
  let anchor = await runtime.enter(Root)
  for (let index = 1; index < depth; index += 1) {
    anchor = await anchor.enter(Layer)
  }

  const coldStart = performance.now()
  const cold = await anchor.enter(Request, { request: { id: 'cold' } })
  const coldMs = performance.now() - coldStart
  await cold.dispose()

  for (let index = 0; index < warmup; index += 1) {
    const env = await anchor.enter(Request, { request: { id: `warmup-${index}` } })
    await env.dispose()
  }

  const samples = []
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now()
    const env = await anchor.enter(Request, { request: { id: index } })
    await env.dispose()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  const inspection = runtime.inspect()
  await runtime.dispose()

  return {
    serviceCount,
    depth,
    iterations,
    coldMs,
    warm: {
      minMs: samples[0],
      p50Ms: percentile(samples, 0.5),
      p95Ms: percentile(samples, 0.95),
      p99Ms: percentile(samples, 0.99),
      maxMs: samples.at(-1),
      meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    },
    planCache: inspection.planCache,
  }
}

const cases = []
for (const serviceCount of [100, 300]) {
  for (const depth of [2, 6]) {
    cases.push(await runCase({ serviceCount, depth }))
  }
}

const result = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuCount: (await import('node:os')).cpus().length,
  },
  methodology: {
    measurement: 'warm sibling Request Entry enter+dispose, no Service materialization',
    warmup: 25,
    iterations: 250,
  },
  cases,
}

console.log(JSON.stringify(result, null, 2))

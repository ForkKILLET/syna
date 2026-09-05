// Hyla-mini request latency, report only (no budget): full HTTP round trips through the dynamic
// path (host → tenant → leased SiteEnv → RequestEntry → renderer/page cache) on the filesystem
// backend and, when SYNA_TEST_PG_URL is set, on PostgreSQL.
// Usage: node benchmarks/hyla-request-latency.mjs [output.json] [--quick]
import { writeFile } from 'node:fs/promises'
import { cpus, platform, release } from 'node:os'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { startHttpServer } from '../apps/hyla-mini/dist/index.js'
import { createFilesystemApp, createPostgresApp, fetchText } from '../apps/hyla-mini/tests/helpers/app-harness.mjs'

const quick = process.argv.includes('--quick')
const outputFile = process.argv.slice(2).find(argument => !argument.startsWith('--'))
const count = quick ? 30 : 200

const percentile = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]
const summarize = samples => {
  const sorted = [...samples].sort((a, b) => a - b)
  return { samples: sorted.length, p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), p99Ms: percentile(sorted, 0.99), maxMs: sorted.at(-1), meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length }
}

async function timedRequests(server, path, host, iterations, before) {
  const samples = []
  let status
  for (let index = 0; index < iterations; index += 1) {
    if (before) await before()
    const started = performance.now()
    const response = await fetchText(`${server.url}${path}`, { headers: { host } })
    samples.push(performance.now() - started)
    status = response.status
    if (status !== 200) throw new Error(`${host}${path} answered ${status}: ${response.body.slice(0, 200)}`)
  }
  return { status, timing: summarize(samples) }
}

async function measure(backend, harness) {
  const domains = await harness.app.domains()
  const server = await startHttpServer({ app: harness.app.app, domains, onError: () => undefined })
  const manager = await harness.app.app.deps.sites.load()
  try {
    // Warm the site world and the page cache once.
    await fetchText(`${server.url}/posts/shared-slug`, { headers: { host: 'alpha.test' } })
    await fetchText(`${server.url}/`, { headers: { host: 'alpha.test' } })
    const cases = []
    cases.push({ name: 'post-page-cached', description: 'GET /posts/shared-slug on a warm SiteEnv (page cache hit; still one content-version read per request)', ...(await timedRequests(server, '/posts/shared-slug', 'alpha.test', count)) })
    cases.push({ name: 'index-cached', description: 'GET / on a warm SiteEnv (page cache hit)', ...(await timedRequests(server, '/', 'alpha.test', count)) })
    cases.push({ name: 'comment-preview-untrusted', description: 'GET /comments/preview?text=… (untrusted pipeline, never cached)', ...(await timedRequests(server, '/comments/preview?text=Hello%20*world*%20%3Cscript%3Ex%3C%2Fscript%3E', 'alpha.test', count)) })
    cases.push({ name: 'post-page-cold-site', description: 'GET /posts/shared-slug after invalidate(): SiteEnv creation (configuration read, Env, authenticator, context) plus a page-cache miss', ...(await timedRequests(server, '/posts/shared-slug', 'alpha.test', Math.max(10, Math.round(count / 4)), async () => { manager.invalidate('alpha') })) })
    const context = (await manager.acquire('alpha', 'background'))
    const cacheStats = { ...context.context.cacheStats }
    context.release()
    return { backend, count, cases, siteManager: manager.stats(), pageCache: cacheStats }
  }
  finally {
    await server.close()
  }
}

const results = []
{
  const harness = await createFilesystemApp()
  try { results.push(await measure('filesystem', harness)) }
  finally { await harness.close() }
}
if (process.env.SYNA_TEST_PG_URL) {
  const harness = await createPostgresApp()
  try { results.push(await measure('postgres', harness)) }
  finally { await harness.close() }
}
else {
  results.push({ backend: 'postgres', skipped: 'SYNA_TEST_PG_URL is not set; run through scripts/pg-test-cluster.mjs with -- …' })
}

const report = {
  generatedAt: new Date().toISOString(),
  quick,
  reportOnly: true,
  note: 'Full HTTP round trips on 127.0.0.1 measured from a node:http client in the same process; not a budget and not a cross-machine claim.',
  environment: { node: process.version, platform: platform(), release: release(), cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length },
  backends: results,
}
const ms = value => (typeof value === 'number' ? `${value.toFixed(2)} ms` : '—')
for (const backend of results) {
  if (backend.skipped) { console.log(`${backend.backend}: skipped (${backend.skipped})`); continue }
  for (const item of backend.cases) console.log(`${backend.backend.padEnd(11)} ${item.name.padEnd(26)} n=${String(item.timing.samples).padStart(3)}  p50 ${ms(item.timing.p50Ms)}  p95 ${ms(item.timing.p95Ms)}  p99 ${ms(item.timing.p99Ms)}`)
}
if (outputFile) {
  await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`written ${outputFile}`)
}

// F-AP3-07 (minor, resources): the pipeline cache is bounded by the constant PIPELINE_CACHE_MAX_ENTRIES = 64
// (not a setting), and every page render of a site builds THREE pipelines (body, comment, preview), so the
// cache holds at most 21 sites' recipes. With 22+ sites in rotation every render rebuilds three processors
// (Ajv option validation + unified assembly) per request: the bound is right, the cost cliff is undocumented.
import { createRuntime } from '@syna/core'
import { PIPELINE_CACHE_MAX_ENTRIES, PipelineBuilder, RenderInfrastructureEntry, Renderer, STAGE_FACTORIES, defaultRecipes } from '../../../../apps/hyla-mini/dist/index.js'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }

const runtime = createRuntime({ services: [PipelineBuilder, Renderer, ...STAGE_FACTORIES] })
const env = await runtime.enter(RenderInfrastructureEntry)
const renderer = await env.deps.renderer.load()
const builder = await env.deps.pipelines.load()
const site = (n, tenants) => {
  const recipes = defaultRecipes()
  // Each site has its own recipe spelling (a distinct preview length), as real tenants do.
  recipes.preview.stages[1].options.maxCharacters = 100 + n
  return { tenantId: `t${n}`, title: `Site ${n}`, domains: [], defaultLocale: 'en', theme: { name: 'paper', accent: '#000' }, navigation: [], recipes, auth: { implementation: { kind: 'persistent-implementation-ref', contractId: 'x', implementationId: 'y', version: '*' }, options: {} }, configRevision: 1 }
}
const post = { id: 'p', tenantId: 't', slug: 'p', locale: 'en', title: 'T', body: 'hello *world*', status: 'published', categories: [], primaryCategory: undefined, tags: [], revision: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
const perSite = 3
const fits = Math.floor(PIPELINE_CACHE_MAX_ENTRIES / perSite)
for (const tenants of [fits, fits + 1]) {
  const sites = Array.from({ length: tenants }, (_, n) => site(n, tenants))
  for (const s of sites) await renderer.renderPostPage(s, { ...post, tenantId: s.tenantId }) // warm
  const before = builder.stats.builds
  for (const s of sites) await renderer.renderPostPage(s, { ...post, tenantId: s.tenantId }) // second round
  const rebuilt = builder.stats.builds - before
  console.log(`info ${tenants} sites in rotation: second round rebuilt ${rebuilt} pipelines (cache entries ${builder.stats.entries}/${builder.stats.maxEntries}, evictions ${builder.stats.evictions})`)
  if (tenants === fits) check(`${tenants} sites: the second round is served from the cache`, rebuilt === 0, rebuilt)
  else check(`${tenants} sites (one more than fits): the second round still mostly hits the cache`, rebuilt < tenants * perSite / 2, { rebuilt, perRequest: rebuilt / tenants })
}
await runtime.dispose()
process.exitCode = failed === 0 ? 0 : 1

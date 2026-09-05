// Attack 7: three recipes × two tenants share one set of factory slots; concurrent renders are deterministic; no factory slot is owned by a Site/Request Env.
import {
  ANONYMOUS, PROBE_REQUEST, PipelineBuilder, Renderer, RequestEntry, STAGE_FACTORIES, bodyRecipe, commentRecipe, factorySetupCounts, previewRecipe,
} from '../../../apps/hyla-mini/dist/index.js'
import { createFilesystemApp } from '../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => {
  failed += ok ? 0 : 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`}`)
}
const watchdog = setTimeout(() => { console.log('FAIL probe timed out'); process.exit(2) }, 60_000)

const setupBefore = { ...factorySetupCounts }
const harness = await createFilesystemApp()
try {
  const store = await harness.app.app.deps.store.load()
  // beta: same three recipe roles, observably different options (six distinct pipelines in total)
  const betaConfig = await store.forTenant('beta').getSiteConfig()
  const betaRecipes = { body: bodyRecipe(), comment: commentRecipe(), preview: previewRecipe(40) }
  betaRecipes.body.stages[1].options = { singleTilde: false }
  betaRecipes.body.stages[3].options = { rel: ['nofollow'] }
  betaRecipes.comment.stages[3].options = { allowImages: true }
  await store.forTenant('beta').saveSiteConfig({ ...betaConfig, recipes: betaRecipes })

  const manager = await harness.app.app.deps.sites.load()
  const alpha = await manager.acquire('alpha', 'request')
  const beta = await manager.acquire('beta', 'request')
  const comment = '~strike~ ![pic](http://img.test/x.png) [link](https://out.test/) <b>raw</b>'
  const ops = {
    alphaShared: () => alpha.context.renderPost('shared-slug', ANONYMOUS).then(page => page.html),
    alphaIndex: () => alpha.context.renderIndex(ANONYMOUS).then(page => page.html),
    alphaComment: () => alpha.context.renderComment(comment),
    betaShared: () => beta.context.renderPost('shared-slug', ANONYMOUS).then(page => page.html),
    betaIndex: () => beta.context.renderIndex(ANONYMOUS).then(page => page.html),
    betaComment: () => beta.context.renderComment(comment),
  }
  const baseline = {}
  for (const [name, op] of Object.entries(ops)) baseline[name] = await op()
  check('alpha comment recipe strips images; beta comment recipe keeps them (different products of one sanitize factory)', !/<img/.test(baseline.alphaComment) && /<img/.test(baseline.betaComment), { alpha: baseline.alphaComment, beta: baseline.betaComment })
  check('comment recipes (singleTilde:false) keep ~strike~ literal and strip raw HTML in both tenants', /~strike~/.test(baseline.alphaComment) && !/<del>/.test(baseline.alphaComment) && !/<b>/.test(baseline.alphaComment) && !/<b>/.test(baseline.betaComment))
  check('body recipes: alpha (singleTilde:true) renders ~~strike~~ as <del>', /<del>strike<\/del>/.test(baseline.alphaShared))
  check('alpha body keeps raw HTML (trusted), beta body links carry rel=nofollow only', /<script>alert\('alpha'\)/.test(baseline.alphaShared) && !/noopener/.test(baseline.betaShared))
  check('outputs are tenant-specific', baseline.alphaShared !== baseline.betaShared && baseline.alphaIndex !== baseline.betaIndex)

  const pipelines = await harness.app.app.deps.pipelines.load()
  const statsAfterBaseline = await pipelines.factoryStats()
  const expectedConfigured = {
    'hyla.mini/remark-parse-factory@0.1.0': 6,
    'hyla.mini/remark-gfm-factory@0.1.0': 4,
    'hyla.mini/remark-excerpt-factory@0.1.0': 2,
    'hyla.mini/remark-rehype-factory@0.1.0': 6,
    // Third review round (I-74): comment pipelines are built `untrusted`; their last rehype stage is the
    // links stage, so the builder appends the platform sanitizer as a final pass (one more configure()
    // per comment pipeline: 4 recipe occurrences + 2 appended passes).
    'hyla.mini/rehype-sanitize-factory@0.1.0': 6,
    'hyla.mini/rehype-external-links-factory@0.1.0': 4,
    'hyla.mini/rehype-stringify-factory@0.1.0': 6,
  }
  check('six distinct pipelines built (3 recipes × 2 tenants)', pipelines.stats.builds === 6, pipelines.stats)
  const sortedJson = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))))
  check('factory.stats.configured = one configure() per distinct stage occurrence', sortedJson(statsAfterBaseline) === sortedJson(expectedConfigured), statsAfterBaseline)

  // 50 concurrent renders across both tenants and all three recipe roles
  const names = Object.keys(ops)
  const results = await Promise.all(Array.from({ length: 50 }, (_, index) => ops[names[index % names.length]]().then(html => ({ name: names[index % names.length], html }))))
  const mismatches = results.filter(result => result.html !== baseline[result.name])
  check('50 concurrent renders equal their serial baselines (no cross-recipe / cross-tenant mutable state)', mismatches.length === 0, mismatches.map(item => item.name))
  const statsAfterStorm = await pipelines.factoryStats()
  check('no additional configure() during the storm (products are reused, not rebuilt per render)', sortedJson(statsAfterStorm) === sortedJson(statsAfterBaseline), statsAfterStorm)
  check('pipeline builder served the storm from its cache', pipelines.stats.builds === 6 && pipelines.stats.cacheHits >= 6, pipelines.stats)

  // Third review round (I-73): the module-global setup counter is no longer written (`factorySetupCounts`
  // is a frozen, deprecated export). Sharing is proven by per-instance tokens: one token per admitted factory,
  // stable across the storm, so every recipe and tenant used the same seven instances.
  void setupBefore
  void factorySetupCounts
  const instances = await pipelines.factoryInstances()
  const instancesAfter = await pipelines.factoryInstances()
  check('each factory Service is one instance shared by every recipe and tenant of this app (seven tokens, unchanged by the storm)',
    Object.keys(instances).length === 7 && new Set(Object.values(instances)).size === 7 && JSON.stringify(instances) === JSON.stringify(instancesAfter), instances)

  // ownership
  const requestEnv = await alpha.env.enter(RequestEntry, { request: PROBE_REQUEST })
  const sharedLabels = new Set([PipelineBuilder.key, Renderer.key, ...STAGE_FACTORIES.map(factory => factory.key)])
  const inspections = { siteAlpha: alpha.env.inspect(), siteBeta: beta.env.inspect(), request: requestEnv.inspect() }
  for (const [name, inspection] of Object.entries(inspections)) {
    const violationsHere = inspection.nodes.filter(node => (sharedLabels.has(node.label) || node.kind === 'all') && node.ownerEnvId !== harness.app.app.id).map(node => `${node.nodeId}@${node.ownerEnvId}`)
    check(`${name} Env: every factory / all-collection / PipelineBuilder / Renderer slot is owned by the app Env`, violationsHere.length === 0, violationsHere)
    const present = inspection.nodes.filter(node => sharedLabels.has(node.label)).length
    check(`${name} Env sees all ${sharedLabels.size} shared render slots (inherited, single copy each)`, present === sharedLabels.size, present)
  }
  await requestEnv.dispose()
  alpha.release()
  beta.release()
}
finally {
  await harness.close()
  clearTimeout(watchdog)
  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
  setTimeout(() => { console.log(`FAIL process still alive 5s after close: ${process.getActiveResourcesInfo()}`); process.exit(1) }, 5000).unref()
  process.exitCode = failed === 0 ? 0 : 1
}

// H05 / H06 / H07 — three recipes share one set of factory slots; recipes persist and resolve.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage } from '@syna/core'
import {
  MarkdownStageFactoryContract,
  PipelineBuilder,
  RecipeError,
  RenderInfrastructureEntry,
  Renderer,
  STAGE_FACTORIES,
  StageFactoryRef,
  RemarkGfmFactory,
  RehypeSanitizeFactory,
  RemarkParseFactory,
  RemarkRehypeFactory,
  RehypeStringifyFactory,
  bodyRecipe,
  commentRecipe,
  defaultRecipes,
  define,
  factorySetupCounts,
  parseRecipeDocument,
  previewRecipe,
  stageRef,
} from '../dist/index.js'

const siteConfig = (tenantId, recipes = defaultRecipes()) => ({
  tenantId,
  title: `Site ${tenantId}`,
  domains: [`${tenantId}.test`],
  defaultLocale: 'en',
  theme: { name: 'paper', accent: '#3366cc' },
  navigation: [{ label: 'Home', href: '/' }],
  recipes,
  auth: { implementation: { kind: 'persistent-implementation-ref', contractId: 'x', implementationId: 'y', version: '*' }, options: {} },
  configRevision: 1,
})

const untrusted = 'Hello <script>alert(1)</script> [link](https://evil.test/x) <img src=x onerror=alert(2)> *ok*'

test('H05 three recipes with observable differences are built from one shared set of factory slots', async () => {
  const before = { ...factorySetupCounts }
  const runtime = createRuntime({ services: [PipelineBuilder, Renderer, ...STAGE_FACTORIES] })
  const env = await runtime.enter(RenderInfrastructureEntry)
  const builder = await env.deps.pipelines.load()
  const { body, comment, preview } = defaultRecipes()
  const [bodyPipe, commentPipe, previewPipe] = await Promise.all([builder.build(body), builder.build(comment), builder.build(preview)])

  assert.deepEqual(bodyPipe.stages.map(stage => stage.pluginId), ['remark-parse', 'remark-gfm', 'remark-rehype', 'rehype-external-links', 'rehype-stringify'])
  assert.deepEqual(commentPipe.stages.map(stage => stage.pluginId), ['remark-parse', 'remark-gfm', 'remark-rehype', 'rehype-sanitize', 'rehype-external-links', 'rehype-stringify'])
  assert.deepEqual(previewPipe.stages.map(stage => stage.pluginId), ['remark-parse', 'remark-excerpt', 'remark-rehype', 'rehype-sanitize', 'rehype-stringify'])

  const bodyHtml = await bodyPipe.process(untrusted)
  const commentHtml = await commentPipe.process(untrusted)
  const previewHtml = await previewPipe.process(`# Title\n\nFirst paragraph.\n\n${'Second paragraph that is long enough to be cut by the excerpt budget of the preview recipe. '.repeat(3)}\n\nThird.`)
  assert.match(bodyHtml, /<script>alert\(1\)<\/script>/, 'trusted body keeps raw HTML')
  assert.match(bodyHtml, /rel="noopener" target="_blank"/)
  assert.doesNotMatch(commentHtml, /<script|onerror|<img/, 'untrusted comment is sanitized')
  assert.match(commentHtml, /rel="nofollow noopener ugc" target="_blank"/, 'later plugins run on the sanitized tree and add safe attributes only')
  assert.match(commentHtml, /<em>ok<\/em>/)
  assert.doesNotMatch(previewHtml, /<h1>/, 'preview drops headings')
  assert.match(previewHtml, /First paragraph/)
  assert.doesNotMatch(previewHtml, /Third/)

  // Every factory Service was set up exactly once in this Runtime world; products differ per recipe.
  for (const factory of STAGE_FACTORIES) {
    const id = factory.family.id.split('/').at(-1).replace('-factory', '')
    assert.equal((factorySetupCounts[id] ?? 0) - (before[id] ?? 0), 1, `${id} set up once`)
  }
  const stats = await builder.factoryStats()
  assert.equal(stats[`${RemarkParseFactory.family.id}@${RemarkParseFactory.version}`], 3, 'parse configured once per recipe')
  assert.equal(stats[`${RehypeSanitizeFactory.family.id}@${RehypeSanitizeFactory.version}`], 2)
  assert.equal(builder.stats.builds, 3)
  await builder.build(body)
  assert.equal(builder.stats.cacheHits, 1)
  await runtime.dispose()
})

test('H05 concurrent rendering across recipes and tenants shares no mutable state (outputs are independent of interleaving)', async () => {
  const runtime = createRuntime({ services: [PipelineBuilder, Renderer, ...STAGE_FACTORIES] })
  const env = await runtime.enter(RenderInfrastructureEntry)
  const renderer = await env.deps.renderer.load()
  const alpha = siteConfig('alpha', { ...defaultRecipes(), preview: previewRecipe(20) })
  const beta = siteConfig('beta', { ...defaultRecipes(), body: commentRecipe() })
  const post = (tenantId, index) => ({
    id: `${tenantId}-${index}`, tenantId, slug: `p${index}`, locale: 'en', title: `T${index}`, status: 'published',
    body: `Para ${tenantId} ${index} <b>raw</b> ~~gfm~~ [x](https://ext.test)\n\nSecond ${index}.`,
    categories: [], primaryCategory: undefined, tags: [], revision: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  })
  const sequential = []
  for (let index = 0; index < 6; index += 1) {
    sequential.push(await renderer.renderPostView(alpha, post('alpha', index)))
    sequential.push(await renderer.renderPostView(beta, post('beta', index)))
  }
  const concurrent = await Promise.all(Array.from({ length: 6 }, (_, index) => [
    renderer.renderPostView(alpha, post('alpha', index)),
    renderer.renderPostView(beta, post('beta', index)),
  ]).flat())
  assert.deepEqual(concurrent.map(view => [view.id, view.bodyHtml, view.previewHtml]), sequential.map(view => [view.id, view.bodyHtml, view.previewHtml]))
  assert.match(sequential[0].bodyHtml, /<b>raw<\/b>/, 'alpha body keeps raw HTML')
  assert.doesNotMatch(sequential[1].bodyHtml, /<b>raw<\/b>/, 'beta body uses the sanitizing comment recipe')
  assert.ok(sequential[0].previewHtml.length < sequential[1].previewHtml.length, 'alpha preview budget is shorter')
  await runtime.dispose()
})

test('H05 recipe validation: stage order, duplicate plugins, option schemas and defaults, unknown contract', async () => {
  const runtime = createRuntime({ services: [PipelineBuilder, ...STAGE_FACTORIES] })
  const env = await runtime.enter(define.entry('builder-only', { requires: { pipelines: PipelineBuilder } }))
  const builder = await env.deps.pipelines.load()
  const body = bodyRecipe()
  const swap = (document, i, j) => ({ ...document, stages: document.stages.map((stage, index) => index === i ? document.stages[j] : index === j ? document.stages[i] : stage) })
  await assert.rejects(builder.build(swap(body, 0, 1)), error => error instanceof RecipeError && /first stage must be a parse/.test(error.message))
  await assert.rejects(builder.build({ ...body, stages: [...body.stages, body.stages[1]] }), error => /duplicate occurrence key/.test(error.message))
  await assert.rejects(
    builder.build({ ...body, stages: [...body.stages.slice(0, 2), { ...body.stages[1], occurrence: 'gfm-again' }, ...body.stages.slice(2)] }),
    error => /uses remark-gfm twice/.test(error.message),
  )
  await assert.rejects(
    builder.build({ ...body, stages: body.stages.map(stage => stage.occurrence === 'gfm' ? { ...stage, options: { singleTilde: 'yes' } } : stage) }),
    error => /Invalid options for stage gfm/.test(error.message),
  )
  await assert.rejects(
    builder.build({ ...body, stages: body.stages.map(stage => stage.occurrence === 'gfm' ? { ...stage, optionsVersion: 2 } : stage) }),
    error => /options version 2/.test(error.message),
  )
  await assert.rejects(builder.build({ formatVersion: 2, name: 'x', stages: [] }), RecipeError)
  const defaulted = await builder.build({ ...body, stages: body.stages.map(stage => stage.occurrence === 'gfm' ? { ...stage, options: {} } : stage) })
  assert.equal(defaulted.stages.length, 5)
  await runtime.dispose()
})

test('H07 recipes round-trip through JSON, resolve inside the saved version intent, upgrade in a new Runtime and fail explicitly without the family', async () => {
  const serialized = JSON.stringify(defaultRecipes())
  const parsed = JSON.parse(serialized)
  for (const role of ['body', 'comment', 'preview']) parseRecipeDocument(parsed[role])
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(defaultRecipes())))

  // Two admitted revisions of the gfm family; the saved ref keeps the user's intent; the resolved version is diagnostics.
  const gfmNext = definePackage({ name: '@hyla/mini', version: '0.2.0', syna: { id: 'hyla.mini' } })
    .service('remark-gfm-factory', { provides: [MarkdownStageFactoryContract], setup: () => (RemarkGfmFactory.setup({}, { signal: new AbortController().signal, onDispose() {} })) })
  const runtime = createRuntime({ services: [PipelineBuilder, ...STAGE_FACTORIES, gfmNext] })
  const env = await runtime.enter(define.entry('builder-multi', { requires: { pipelines: PipelineBuilder } }))
  const builder = await env.deps.pipelines.load()
  const saved = parseRecipeDocument(parsed.body)
  const gfmStage = saved.stages.find(stage => stage.occurrence === 'gfm')
  assert.equal(gfmStage.ref.version, '^0.1.0', 'saved intent is the caret of the version that authored it')
  const built = await builder.build(saved)
  assert.equal(built.stages.find(stage => stage.occurrence === 'gfm').resolvedVersion, '0.1.0', '^0.1.0 does not reach 0.2.0')
  const widened = { ...saved, stages: saved.stages.map(stage => stage.occurrence === 'gfm' ? { ...stage, ref: { ...stage.ref, version: '>=0.1.0 <1' } } : stage) }
  assert.equal((await builder.build(widened)).stages.find(stage => stage.occurrence === 'gfm').resolvedVersion, '0.2.0', 'a user range that admits the upgrade resolves to it')
  assert.deepEqual(runtime.catalog.revisions(RemarkGfmFactory.family.id), ['0.2.0', '0.1.0'])
  assert.equal(gfmStage.ref.implementationId, RemarkGfmFactory.family.id, 'exported names carry no version')
  await runtime.dispose()

  const withoutGfm = createRuntime({ services: [PipelineBuilder, ...STAGE_FACTORIES.filter(factory => factory !== RemarkGfmFactory)] })
  const bare = await withoutGfm.enter(define.entry('builder-bare', { requires: { pipelines: PipelineBuilder } }))
  await assert.rejects((await bare.deps.pipelines.load()).build(saved), error => error.code === 'MISSING_IMPLEMENTATION' && /no supplier substitution/.test(error.message))
  await withoutGfm.dispose()

  const viaBinding = StageFactoryRef.to(RemarkParseFactory, '~0.1.0')
  assert.deepEqual(stageRef(RemarkParseFactory, '~0.1.0'), viaBinding)
  assert.throws(() => StageFactoryRef.to(PipelineBuilder), /does not explicitly provide/)
  void RemarkRehypeFactory
  void RehypeStringifyFactory
})

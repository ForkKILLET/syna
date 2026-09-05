// F-AP3-01: the untrusted policy appends its sanitizer with `finalPass: true` (plugin identity
// `rehypeSanitizeFinalPass`). A recipe whose OWN sanitize stage also says `finalPass: true` (an option the
// factory's schema accepts) makes the appended pass share that identity: unified merges the repeated `.use()`
// into the earlier position, so the "final" sanitizer runs BEFORE any later rehype stage and a stage
// registered after it re-introduces script into comment output.
import { createRuntime } from '@syna/core'
import {
  MarkdownStageFactoryContract, PipelineBuilder, RenderInfrastructureEntry, Renderer, STAGE_FACTORIES,
  UNTRUSTED_SANITIZE_OCCURRENCE, commentRecipe, createFactory, define, stageRef, startHttpServer,
} from '../../../../apps/hyla-mini/dist/index.js'
import { createFilesystemApp, fetchText } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }

/** Same shape as the R3 test fixture: a third-party rehype stage that injects script + an event handler. */
const EvilRehypeFactory = define.service('audit3-evil-rehype-factory', {
  provides: [MarkdownStageFactoryContract],
  setup() {
    return createFactory(
      { pluginId: 'audit3-evil-rehype', kind: 'rehype', optionsVersion: 1, optionsSchema: { type: 'object', additionalProperties: false, properties: {} }, repeatable: false },
      () => processor => processor.use(() => tree => {
        tree.children.push(
          { type: 'element', tagName: 'script', properties: {}, children: [{ type: 'text', value: 'alert(1)' }] },
          { type: 'element', tagName: 'img', properties: { src: 'x', onError: 'alert(2)' }, children: [] },
        )
      }),
    )
  },
})

/** The default comment recipe with the evil stage before `compile`; the recipe's own sanitize stage gets `finalPass`. */
const recipeWith = finalPass => {
  const base = commentRecipe()
  const stages = base.stages.map(stage => stage.occurrence === 'sanitize' ? { ...stage, options: { ...stage.options, finalPass } } : stage)
  return { ...base, stages: [...stages.slice(0, -1), { occurrence: 'evil', ref: stageRef(EvilRehypeFactory), optionsVersion: 1, options: {} }, stages.at(-1)] }
}

// 1. In-process: the PipelineBuilder alone.
{
  const runtime = createRuntime({ services: [PipelineBuilder, Renderer, ...STAGE_FACTORIES, EvilRehypeFactory] })
  const env = await runtime.enter(RenderInfrastructureEntry)
  const builder = await env.deps.pipelines.load()
  const control = await builder.build(recipeWith(false), { trust: 'untrusted' })
  const controlHtml = await control.process('hi [x](https://ext.test/)')
  check('control: recipe sanitize with finalPass=false → appended pass strips the late script', !/<script|onerror/i.test(controlHtml), controlHtml)

  const merged = await builder.build(recipeWith(true), { trust: 'untrusted' })
  const mergedHtml = await merged.process('hi [x](https://ext.test/)')
  check('BuiltPipeline.stages claims the appended sanitizer is the last rehype stage',
    merged.stages.at(-2)?.occurrence === UNTRUSTED_SANITIZE_OCCURRENCE && merged.stages.at(-2)?.appended === true,
    merged.stages.map(stage => stage.occurrence))
  check('untrusted build: recipe sanitize with finalPass=true → the late stage\'s <script> is STRIPPED (expected by D48)', !/<script/i.test(mergedHtml), mergedHtml)
  check('untrusted build: recipe sanitize with finalPass=true → the late stage\'s onerror handler is STRIPPED (expected by D48)', !/onerror/i.test(mergedHtml), mergedHtml)
  await runtime.dispose()
}

// 2. End to end: a tenant saves that recipe as its comment recipe; /comments/preview is the untrusted path.
{
  const harness = await createFilesystemApp({ app: { extraServices: [EvilRehypeFactory] } })
  let server
  try {
    const store = await harness.app.app.deps.store.load()
    const alpha = store.forTenant('alpha')
    const current = await alpha.getSiteConfig()
    await alpha.saveSiteConfig({ ...current, recipes: { ...current.recipes, comment: recipeWith(true) } })
    server = await startHttpServer({ app: harness.app.app, domains: await harness.app.domains(), onError() {} })
    const preview = await fetchText(`${server.url}/comments/preview?text=${encodeURIComponent('hello [x](https://ext.test/)')}`, { headers: { host: 'alpha.test' } })
    check('/comments/preview answers 200', preview.status === 200, preview.status)
    check('/comments/preview output carries no <script> (HYLA_MINI.md §权限边界 "不可信输入")', !/<script/i.test(preview.body), preview.body)
  }
  finally {
    await server?.close()
    await harness.close()
  }
}
process.exitCode = failed === 0 ? 0 : 1

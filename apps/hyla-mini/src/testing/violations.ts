/**
 * Fixtures that VIOLATE the Hyla plugin protocol on purpose. They are exported
 * for tests and preflight demonstrations; a deployment must never admit them.
 */
import remarkGfm from 'remark-gfm'
import { define } from '../syna.js'
import { MarkdownStageFactoryContract, createFactory } from '../render/stages.js'
import { CurrentRequest, SiteSnapshot } from '../site/inputs.js'
import { PipelineBuilder } from '../render/pipeline.js'
import { Renderer, type Renderer as RendererApi } from '../render/renderer.js'

/** A shared factory that reads the current request: refused by the render-infrastructure preflight. */
export const RequestAwareStageFactory = define.service('request-aware-stage-factory', {
  provides: [MarkdownStageFactoryContract],
  requires: { request: CurrentRequest },
  setup({ request }) {
    const facts = request.read()
    return createFactory(
      { pluginId: 'request-aware-gfm', kind: 'transform', optionsVersion: 1, optionsSchema: { type: 'object', additionalProperties: false, properties: {} }, repeatable: false },
      () => processor => processor.use(remarkGfm, { singleTilde: facts.path.length % 2 === 0 }),
    )
  },
})

/** A renderer replacement that reads the site snapshot: plans, but forks per site and breaks the site budget. */
export const SiteAwareRenderer = define.service('site-aware-renderer', {
  requires: { pipelines: PipelineBuilder, snapshot: SiteSnapshot },
  async setup({ pipelines }): Promise<RendererApi> {
    const real = await Renderer.setup({ pipelines } as never, { signal: new AbortController().signal, onDispose() {} })
    return real
  },
})

/** Closure-pollution probe: a factory whose configure() mutates shared module state. Tests assert the protocol test catches it. */
export const pollutionLog: string[] = []
export const PollutingStageFactory = define.service('polluting-stage-factory', {
  provides: [MarkdownStageFactoryContract],
  setup() {
    let lastOptions: Record<string, unknown> = {}
    return createFactory(
      { pluginId: 'polluting-gfm', kind: 'transform', optionsVersion: 1, optionsSchema: { type: 'object', additionalProperties: false, properties: { tag: { type: 'string', default: 'a' } } }, repeatable: false },
      options => {
        lastOptions = { ...options } // shared across products: a protocol violation
        return processor => processor.use(remarkGfm, { singleTilde: String(lastOptions.tag).length > 0 }).use(() => () => { pollutionLog.push(String(lastOptions.tag)) })
      },
    )
  },
})

import { define } from '../syna.js'
import { PipelineBuilder } from './pipeline.js'
import { Renderer } from './renderer.js'
import { MarkdownStageFactoryContract } from './stages.js'

/**
 * The public render infrastructure of a deployment. Startup preflight checks
 * and explains this Entry (including the whole factory collection) before the
 * server listens: a factory that depends on request or site facts is rejected
 * here, not on some tenant's first request.
 */
export const RenderInfrastructureEntry = define.entry('render-infrastructure', {
  requires: {
    factories: MarkdownStageFactoryContract.all,
    pipelines: PipelineBuilder,
    renderer: Renderer,
  },
})

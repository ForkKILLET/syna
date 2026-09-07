import { define } from '../syna.js'
import { ContentBackend } from '../domain/content.js'
import { MarkdownStageFactoryContract } from '../render/stages.js'
import { PipelineBuilder } from '../render/pipeline.js'
import { Renderer } from '../render/renderer.js'
import { SiteManagerOptions } from './inputs.js'
import { SiteEnvironmentManager } from './manager.js'
import { MaintenanceWorker } from './worker.js'

/**
 * The application world. It owns every shared resource: the content store
 * (pool or root directory), the render infrastructure and the SiteEnv working
 * set manager. Sites and requests are descendants and reuse all of it.
 */
export const AppEntry = define.entry('app', {
  requires: {
    store: ContentBackend,
    factories: MarkdownStageFactoryContract.all,
    pipelines: PipelineBuilder,
    renderer: Renderer,
    sites: SiteEnvironmentManager,
    worker: MaintenanceWorker,
  },
  parameters: { backend: ContentBackend, siteManager: SiteManagerOptions },
})

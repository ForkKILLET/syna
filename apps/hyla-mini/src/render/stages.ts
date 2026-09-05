import type { Processor } from 'unified'
import { define } from '../syna.js'

/**
 * Hyla plugin protocol. A Markdown pipeline is a sequence of stages of these
 * kinds, in this order: exactly one `parse`, any `transform` (mdast), exactly
 * one `bridge` (mdast → hast), any `rehype` (hast), exactly one `compile`.
 * Syna knows nothing about stages; the ordering rule is enforced by the
 * PipelineBuilder, an application Service.
 */
export type StageKind = 'parse' | 'transform' | 'bridge' | 'rehype' | 'compile'
export const STAGE_ORDER: readonly StageKind[] = Object.freeze(['parse', 'transform', 'bridge', 'rehype', 'compile'])

export type JsonSchema = Readonly<Record<string, unknown>>

export interface ConfiguredStage {
  readonly pluginId: string
  readonly kind: StageKind
  /** Adds this stage's plugin to a unified processor. */
  apply(processor: Processor<any, any, any, any, any>): Processor<any, any, any, any, any>
}

/**
 * A shared Factory Service. `configure()` produces independent products for
 * different options; the factory slot itself is shared by every recipe and
 * tenant. Factories may only depend on what the RenderInfrastructureEntry
 * publicly provides — never on request or site facts (those arrive as
 * configure()/render() arguments).
 */
export interface MarkdownStageFactory {
  readonly pluginId: string
  readonly kind: StageKind
  readonly optionsVersion: number
  readonly optionsSchema: JsonSchema
  /** Whether one recipe may use this plugin more than once (unified merges repeated `.use()` settings otherwise). */
  readonly repeatable: boolean
  configure(options: Readonly<Record<string, unknown>>): ConfiguredStage
  /** Observable counters used by tests to prove sharing and absence of cross-recipe state. */
  readonly stats: { readonly configured: number }
}

export const MarkdownStageFactoryContract = define.contract<MarkdownStageFactory>('markdown-stage-factory', {
  metadata: { displayName: 'Markdown stage factory' },
})

/** Persistent references to stage factories are produced through this Binding's `to()`. */
export const StageFactoryRef = define.binding('stage-factory', MarkdownStageFactoryContract)

export function createFactory(
  descriptor: Pick<MarkdownStageFactory, 'pluginId' | 'kind' | 'optionsVersion' | 'optionsSchema' | 'repeatable'>,
  build: (options: Readonly<Record<string, unknown>>) => (processor: Processor<any, any, any, any, any>) => Processor<any, any, any, any, any>,
): MarkdownStageFactory {
  let configured = 0
  return {
    ...descriptor,
    stats: {
      get configured() { return configured },
    },
    configure(options) {
      configured += 1
      const apply = build(Object.freeze({ ...options }))
      return Object.freeze({ pluginId: descriptor.pluginId, kind: descriptor.kind, apply })
    },
  }
}

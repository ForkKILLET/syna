import { randomUUID } from 'node:crypto'
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
/**
 * Declared by a sanitizing `rehype` factory. The PipelineBuilder appends such a
 * factory, configured with `options`, as the final rehype stage of every
 * pipeline built as `untrusted` whose recipe does not already end its rehype
 * stages with a sanitizer. `options` must make the factory add a pass of its
 * own (unified merges repeated uses of one plugin identity into the first).
 */
export interface SanitizerRole {
  readonly options: Readonly<Record<string, unknown>>
}

export interface MarkdownStageFactory {
  readonly pluginId: string
  readonly kind: StageKind
  readonly optionsVersion: number
  readonly optionsSchema: JsonSchema
  /** Whether one recipe may use this plugin more than once (unified merges repeated `.use()` settings otherwise). */
  readonly repeatable: boolean
  /** Present on sanitizing factories: the platform's guarantee for untrusted input. */
  readonly sanitizer?: SanitizerRole
  configure(options: Readonly<Record<string, unknown>>): ConfiguredStage
  /**
   * Observable counters used by tests to prove sharing and absence of
   * cross-recipe state. `instance` is a token minted when the factory instance
   * was created (one per Service setup): equal tokens across recipes prove one
   * shared slot, different tokens across Runtimes prove separate worlds.
   */
  readonly stats: { readonly configured: number; readonly instance: string }
}

export const MarkdownStageFactoryContract = define.contract<MarkdownStageFactory>('markdown-stage-factory', {
  metadata: { displayName: 'Markdown stage factory' },
})

/** Persistent references to stage factories are produced through this Binding's `to()`. */
export const StageFactoryRef = define.binding('stage-factory', MarkdownStageFactoryContract)

export function createFactory(
  descriptor: Pick<MarkdownStageFactory, 'pluginId' | 'kind' | 'optionsVersion' | 'optionsSchema' | 'repeatable' | 'sanitizer'>,
  build: (options: Readonly<Record<string, unknown>>) => (processor: Processor<any, any, any, any, any>) => Processor<any, any, any, any, any>,
): MarkdownStageFactory {
  let configured = 0
  const instance = randomUUID() // per factory instance; no module-global state is touched
  return {
    ...descriptor,
    stats: {
      get configured() { return configured },
      get instance() { return instance },
    },
    configure(options) {
      configured += 1
      const apply = build(Object.freeze({ ...options }))
      return Object.freeze({ pluginId: descriptor.pluginId, kind: descriptor.kind, apply })
    },
  }
}

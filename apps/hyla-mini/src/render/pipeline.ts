import { unified, type Processor } from 'unified'
import type { ImplementationSet } from '@syna/core'
import type { RecipeDocument } from '../domain/model.js'
import { define } from '../syna.js'
import { RecipeError, parseRecipeDocument, validateStageOptions } from './recipe.js'
import { MarkdownStageFactoryContract, STAGE_ORDER, type MarkdownStageFactory, type StageKind } from './stages.js'

export interface BuiltStage {
  readonly occurrence: string
  readonly pluginId: string
  readonly kind: StageKind
  /** The exact factory revision this build resolved to (diagnostics; the recipe keeps the user's intent). */
  readonly resolvedVersion: string
}

export interface BuiltPipeline {
  readonly name: string
  readonly stages: readonly BuiltStage[]
  /** Renders Markdown to an HTML fragment. Safe to call concurrently; the processor is frozen. */
  process(markdown: string): Promise<string>
}

export interface PipelineBuilder {
  build(document: unknown): Promise<BuiltPipeline>
  /** Distinct recipe documents built so far (by content). */
  readonly stats: { readonly builds: number; readonly cacheHits: number }
  /** Setup counters of every admitted factory, for sharing proofs. */
  factoryStats(): Promise<Readonly<Record<string, number>>>
}

function assertStageOrder(name: string, kinds: readonly StageKind[]): void {
  const problems: string[] = []
  const count = (kind: StageKind) => kinds.filter(item => item === kind).length
  if (kinds[0] !== 'parse') problems.push('the first stage must be a parse stage')
  if (kinds.at(-1) !== 'compile') problems.push('the last stage must be a compile stage')
  for (const kind of ['parse', 'bridge', 'compile'] as const) {
    if (count(kind) !== 1) problems.push(`exactly one ${kind} stage is required (found ${count(kind)})`)
  }
  let rank = -1
  for (const kind of kinds) {
    const next = STAGE_ORDER.indexOf(kind)
    if (next < rank) problems.push(`stage kind ${kind} appears after a later kind`)
    rank = Math.max(rank, next)
  }
  if (problems.length > 0) throw new RecipeError(`Recipe ${name} has an invalid stage order`, problems, name)
}

/**
 * Builds unified processors from JSON recipes using the shared factory
 * collection. Building produces independent processor products; the factory
 * Service slots are shared across recipes, sites and requests.
 */
export const PipelineBuilder = define.service('pipeline-builder', {
  provides: [],
  requires: { factories: MarkdownStageFactoryContract.all },
  async setup({ factories }): Promise<PipelineBuilder> {
    const set: ImplementationSet<typeof MarkdownStageFactoryContract> = await factories.load()
    const cache = new Map<string, Promise<BuiltPipeline>>()
    let builds = 0
    let cacheHits = 0

    const buildUncached = async (document: RecipeDocument): Promise<BuiltPipeline> => {
      builds += 1
      const resolved: Array<{ factory: MarkdownStageFactory; version: string; stage: RecipeDocument['stages'][number] }> = []
      for (const stage of document.stages) {
        if (stage.ref.contractId !== MarkdownStageFactoryContract.id) {
          throw new RecipeError(`Stage ${stage.occurrence} references Contract ${stage.ref.contractId}`, ['only markdown stage factories may appear in a recipe'], document.name)
        }
        const candidate = set.resolve(stage.ref)
        const factory = await set.load(candidate)
        resolved.push({ factory, version: candidate.version, stage })
      }
      assertStageOrder(document.name, resolved.map(item => item.factory.kind))
      const seenPlugins = new Set<string>()
      for (const { factory, stage } of resolved) {
        if (seenPlugins.has(factory.pluginId) && !factory.repeatable) {
          throw new RecipeError(
            `Recipe ${document.name} uses ${factory.pluginId} twice`,
            [`stage ${stage.occurrence}: unified would merge repeated .use() settings; the factory is not marked repeatable`],
            document.name,
          )
        }
        seenPlugins.add(factory.pluginId)
      }
      let processor: Processor<any, any, any, any, any> = unified()
      const stages: BuiltStage[] = []
      for (const { factory, version, stage } of resolved) {
        const options = validateStageOptions(factory, stage)
        processor = factory.configure(options).apply(processor)
        stages.push(Object.freeze({ occurrence: stage.occurrence, pluginId: factory.pluginId, kind: factory.kind, resolvedVersion: version }))
      }
      processor.freeze()
      return Object.freeze({
        name: document.name,
        stages: Object.freeze(stages),
        async process(markdown: string) {
          const file = await processor.process(markdown)
          return String(file)
        },
      })
    }

    return {
      stats: {
        get builds() { return builds },
        get cacheHits() { return cacheHits },
      },
      async factoryStats() {
        const entries = await Promise.all(set.candidates.map(async candidate => {
          const factory = await set.load(candidate)
          return [`${candidate.familyId}@${candidate.version}`, factory.stats.configured] as const
        }))
        return Object.freeze(Object.fromEntries(entries))
      },
      build(input) {
        const document = parseRecipeDocument(input)
        const key = JSON.stringify(document)
        const cached = cache.get(key)
        if (cached) {
          cacheHits += 1
          return cached
        }
        const pending = buildUncached(document)
        cache.set(key, pending)
        pending.catch(() => cache.delete(key))
        return pending
      },
    }
  },
})

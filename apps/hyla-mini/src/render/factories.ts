import type { Root as HastRoot, Element } from 'hast'
import type { Root as MdastRoot, RootContent } from 'mdast'
import rehypeSanitize, { defaultSchema, type Options as Schema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import type { Plugin } from 'unified'
import { visit } from 'unist-util-visit'
import { define } from '../syna.js'
import { MarkdownStageFactoryContract, createFactory } from './stages.js'

/**
 * @deprecated Never written since the third review round: a module-global
 * counter was mutable state shared by every Runtime in the process (and by
 * every factory setup, a violation of the plugin protocol Hyla asks of third
 * parties). Sharing is proven per instance instead: `PipelineBuilder.factoryInstances()`
 * returns one token per factory instance (`MarkdownStageFactory.stats.instance`).
 */
export const factorySetupCounts: Readonly<Record<string, number>> = Object.freeze({})

export const RemarkParseFactory = define.service('remark-parse-factory', {
  provides: [MarkdownStageFactoryContract],
  setup() {
    return createFactory(
      { pluginId: 'remark-parse', kind: 'parse', optionsVersion: 1, optionsSchema: { type: 'object', additionalProperties: false, properties: {} }, repeatable: false },
      () => processor => processor.use(remarkParse),
    )
  },
})

export const RemarkGfmFactory = define.service('remark-gfm-factory', {
  provides: [MarkdownStageFactoryContract],
  setup() {
    return createFactory(
      {
        pluginId: 'remark-gfm',
        kind: 'transform',
        optionsVersion: 1,
        optionsSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { singleTilde: { type: 'boolean', default: true } },
        },
        repeatable: false,
      },
      options => processor => processor.use(remarkGfm, { singleTilde: options.singleTilde as boolean }),
    )
  },
})

/** Keeps only the leading content up to `maxCharacters` of text; drops headings. */
const remarkExcerpt: Plugin<[{ maxCharacters: number }], MdastRoot> = ({ maxCharacters }) => tree => {
  const kept: RootContent[] = []
  let budget = maxCharacters
  for (const node of tree.children) {
    if (node.type === 'heading') continue
    if (budget <= 0) break
    let length = 0
    visit(node, 'text', text => { length += text.value.length })
    kept.push(node)
    budget -= length
  }
  tree.children = kept
}

export const RemarkExcerptFactory = define.service('remark-excerpt-factory', {
  provides: [MarkdownStageFactoryContract],
  setup() {
    return createFactory(
      {
        pluginId: 'remark-excerpt',
        kind: 'transform',
        optionsVersion: 1,
        optionsSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['maxCharacters'],
          properties: { maxCharacters: { type: 'integer', minimum: 1, maximum: 10_000 } },
        },
        repeatable: false,
      },
      options => processor => processor.use(remarkExcerpt, { maxCharacters: options.maxCharacters as number }),
    )
  },
})

export const RemarkRehypeFactory = define.service('remark-rehype-factory', {
  provides: [MarkdownStageFactoryContract],
  setup() {
    return createFactory(
      {
        pluginId: 'remark-rehype',
        kind: 'bridge',
        optionsVersion: 1,
        optionsSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { allowDangerousHtml: { type: 'boolean', default: false } },
        },
        repeatable: false,
      },
      options => processor => processor.use(remarkRehype, { allowDangerousHtml: options.allowDangerousHtml as boolean }),
    )
  },
})

const LINK_REL_TOKENS = ['nofollow', 'noopener', 'noreferrer', 'ugc'] as const

/** The default schema, minus images on request, plus the attributes the platform's own link stage adds (`rel` tokens, `target="_blank"`). */
function sanitizeSchema(options: Readonly<Record<string, unknown>>): Schema {
  const tagNames = options.allowImages ? defaultSchema.tagNames : (defaultSchema.tagNames ?? []).filter(tag => tag !== 'img')
  const attributes = options.allowLinkTargets
    ? { ...defaultSchema.attributes, a: [...(defaultSchema.attributes?.a ?? []), ['rel', ...LINK_REL_TOKENS], ['target', '_blank']] }
    : defaultSchema.attributes
  return { ...defaultSchema, tagNames, attributes } as Schema
}

/**
 * A fresh identity of the sanitize plugin for one configuration. unified merges
 * repeated uses of one plugin function into the first, so a sanitizer appended
 * after a recipe's own sanitize stage would only re-configure that earlier pass;
 * a plugin function created per configuration is a pass of its own, run where
 * the builder puts it (last among the rehype stages). One shared "final pass"
 * identity would not do: a recipe that itself uses `finalPass: true` would
 * absorb the builder's appended pass the same way (audit 3, F-AP3-01).
 */
const rehypeSanitizeOwnPass = (): Plugin<[Schema], HastRoot> => schema => rehypeSanitize(schema) as never

export const RehypeSanitizeFactory = define.service('rehype-sanitize-factory', {
  provides: [MarkdownStageFactoryContract],
  setup() {
    return createFactory(
      {
        pluginId: 'rehype-sanitize',
        kind: 'rehype',
        optionsVersion: 1,
        optionsSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            allowImages: { type: 'boolean', default: true },
            /** Keep `rel` (known tokens) and `target="_blank"` on links, which the platform's link stage adds. */
            allowLinkTargets: { type: 'boolean', default: false },
            /** Run as an additional pass even when the recipe already used rehype-sanitize earlier (builder use). */
            finalPass: { type: 'boolean', default: false },
          },
        },
        repeatable: false,
        sanitizer: { options: { allowImages: true, allowLinkTargets: true, finalPass: true } },
      },
      options => processor => {
        const schema = sanitizeSchema(options)
        const plugin = options.finalPass ? rehypeSanitizeOwnPass() : rehypeSanitize
        return processor.use(plugin, schema)
      },
    )
  },
})

/** Marks every absolute http(s) link as external. Runs on hast after sanitize so it cannot re-introduce removed content. */
const rehypeExternalLinks: Plugin<[{ rel: readonly string[] }], HastRoot> = ({ rel }) => tree => {
  visit(tree, 'element', (node: Element) => {
    if (node.tagName !== 'a') return
    const href = node.properties.href
    if (typeof href !== 'string' || !/^https?:\/\//i.test(href)) return
    node.properties.rel = [...rel]
    node.properties.target = '_blank'
  })
}

export const RehypeExternalLinksFactory = define.service('rehype-external-links-factory', {
  provides: [MarkdownStageFactoryContract],
  setup() {
    return createFactory(
      {
        pluginId: 'rehype-external-links',
        kind: 'rehype',
        optionsVersion: 1,
        optionsSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            rel: { type: 'array', items: { type: 'string', enum: ['nofollow', 'noopener', 'noreferrer', 'ugc'] }, default: ['nofollow', 'noopener'] },
          },
        },
        repeatable: false,
      },
      options => processor => processor.use(rehypeExternalLinks, { rel: options.rel as readonly string[] }),
    )
  },
})

export const RehypeStringifyFactory = define.service('rehype-stringify-factory', {
  provides: [MarkdownStageFactoryContract],
  setup() {
    return createFactory(
      {
        pluginId: 'rehype-stringify',
        kind: 'compile',
        optionsVersion: 1,
        optionsSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { allowDangerousHtml: { type: 'boolean', default: false } },
        },
        repeatable: false,
      },
      options => processor => processor.use(rehypeStringify, { allowDangerousHtml: options.allowDangerousHtml as boolean }),
    )
  },
})

/** Every factory Service Hyla-mini ships. Deployments admit these (plus any third-party factory). */
export const STAGE_FACTORIES = Object.freeze([
  RemarkParseFactory,
  RemarkGfmFactory,
  RemarkExcerptFactory,
  RemarkRehypeFactory,
  RehypeSanitizeFactory,
  RehypeExternalLinksFactory,
  RehypeStringifyFactory,
])

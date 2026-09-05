import type { Root as HastRoot, Element } from 'hast'
import type { Root as MdastRoot, RootContent } from 'mdast'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import type { Plugin } from 'unified'
import { visit } from 'unist-util-visit'
import { define } from '../syna.js'
import { MarkdownStageFactoryContract, createFactory } from './stages.js'

/** Module-level counters let tests prove each factory Service was set up once per Runtime world. */
export const factorySetupCounts: Record<string, number> = {}
function countSetup(id: string): void {
  factorySetupCounts[id] = (factorySetupCounts[id] ?? 0) + 1
}

export const RemarkParseFactory = define.service('remark-parse-factory', {
  provides: [MarkdownStageFactoryContract],
  setup() {
    countSetup('remark-parse')
    return createFactory(
      { pluginId: 'remark-parse', kind: 'parse', optionsVersion: 1, optionsSchema: { type: 'object', additionalProperties: false, properties: {} }, repeatable: false },
      () => processor => processor.use(remarkParse),
    )
  },
})

export const RemarkGfmFactory = define.service('remark-gfm-factory', {
  provides: [MarkdownStageFactoryContract],
  setup() {
    countSetup('remark-gfm')
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
    countSetup('remark-excerpt')
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
    countSetup('remark-rehype')
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

export const RehypeSanitizeFactory = define.service('rehype-sanitize-factory', {
  provides: [MarkdownStageFactoryContract],
  setup() {
    countSetup('rehype-sanitize')
    return createFactory(
      {
        pluginId: 'rehype-sanitize',
        kind: 'rehype',
        optionsVersion: 1,
        optionsSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { allowImages: { type: 'boolean', default: true } },
        },
        repeatable: false,
      },
      options => processor => {
        const schema = options.allowImages
          ? defaultSchema
          : { ...defaultSchema, tagNames: (defaultSchema.tagNames ?? []).filter(tag => tag !== 'img') }
        return processor.use(rehypeSanitize, schema)
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
    countSetup('rehype-external-links')
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
    countSetup('rehype-stringify')
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

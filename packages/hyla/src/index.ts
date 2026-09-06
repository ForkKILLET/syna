import type {
  ImplementationCandidate,
  ImplementationRef,
} from '@syna/core'
import {
  LlmCall,
  LlmConnector,
  type LlmConnector as LlmConnectorApi,
} from '@syna-demo/llm-contract'
import { Logger } from '@syna-demo/logger'
import {
  Postgres,
  PostgresConfig,
  type PostgresOptions,
} from '@syna-demo/postgres'
import { define } from './syna.js'

export interface Blog {
  readonly id: string
  readonly title: string
}

export const CurrentBlog = define.input<Blog>('current-blog', {
  metadata: { displayName: 'Current blog' },
})

export const ArticleSummaryLlm = define.binding(
  'article-summary-llm',
  LlmConnector,
  {
    metadata: {
      displayName: 'Article summary LLM',
      description: 'The provider selected for article summaries.',
    },
  },
)

export interface HylaApplication {
  status(): Promise<{
    readonly databasePool: number
    readonly databaseUrl: string
  }>
}

export const HylaApplication = define.service('application', {
  requires: {
    database: Postgres,
    logger: Logger,
  },
  setup({ database, logger }): HylaApplication {
    return {
      async status() {
        const db = await database.load()
        const log = await logger.load()
        log.info('Hyla application is ready')
        return {
          databasePool: db.poolId,
          databaseUrl: db.connectionString,
        }
      },
    }
  },
})

export interface BlogRuntime {
  describe(): Promise<string>
  databasePool(): Promise<number>
}

export const BlogRuntime = define.service('blog-runtime', {
  requires: {
    blog: CurrentBlog,
    database: Postgres,
  },
  setup({ blog, database }): BlogRuntime {
    return {
      async describe() {
        const current = blog.read()
        return `${current.title} (${current.id})`
      },
      async databasePool() {
        return (await database.load()).poolId
      },
    }
  },
})

export interface ArticleSummarizer {
  summarize(article: string): Promise<string>
  provider(): Promise<string>
}

export const ArticleSummarizer = define.service('article-summarizer', {
  requires: {
    blog: CurrentBlog,
    call: LlmCall,
    llm: ArticleSummaryLlm,
  },
  setup({ blog, call, llm }): ArticleSummarizer {
    return {
      async summarize(article) {
        const currentBlog = blog.read()
        const callContext = call.read()
        const connector = await llm.load()
        return connector.complete(
          `Summarize for ${currentBlog.title} (${callContext.requestId}): ${article}`,
        )
      },
      async provider() {
        return (await llm.load()).provider
      },
    }
  },
})

export interface ProviderPanel {
  list(): Promise<readonly ImplementationCandidate<typeof LlmConnector>[]>
  run(
    provider: ImplementationRef<typeof LlmConnector>,
    prompt: string,
  ): Promise<string>
}

export const ProviderPanel = define.service('provider-panel', {
  requires: {
    providers: LlmConnector.all,
  },
  setup({ providers }): ProviderPanel {
    return {
      async list() {
        return (await providers.load()).candidates
      },
      async run(provider, prompt) {
        const implementations = await providers.load()
        const connector: LlmConnectorApi = await implementations.load(provider)
        return connector.complete(prompt)
      },
    }
  },
})

export const AppEntry = define.entry('app', {
  requires: {
    app: HylaApplication,
  },
  parameters: {
    database: PostgresConfig,
  },
})

export const BlogEntry = define.entry('blog', {
  requires: {
    blog: BlogRuntime,
  },
  parameters: {
    currentBlog: CurrentBlog,
    summaryLlm: ArticleSummaryLlm,
  },
})

export const RequestEntry = define.entry('request', {
  requires: {
    summarizer: ArticleSummarizer,
  },
  parameters: {
    call: LlmCall,
  },
})

export const ProvidersEntry = define.entry('providers', {
  requires: {
    panel: ProviderPanel,
  },
  parameters: {
    call: LlmCall,
  },
})

export type { PostgresOptions }

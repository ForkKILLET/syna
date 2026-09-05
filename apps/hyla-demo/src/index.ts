import { createRuntime } from '@syna/core'
import { Claude } from '@syna-demo/claude'
import {
  AppEntry,
  ArticleSummarizer,
  ArticleSummaryLlm,
  BlogEntry,
  BlogRuntime,
  HylaApplication,
  ProviderPanel,
  ProvidersEntry,
  RequestEntry,
} from '@syna-demo/hyla'
import { LlmConnector } from '@syna-demo/llm-contract'
import { OpenAI as OpenAIv1 } from '@syna-demo/openai-v1'
import { OpenAI as OpenAIv2 } from '@syna-demo/openai-v2'
import { Postgres } from '@syna-demo/postgres'

const runtime = createRuntime({
  services: [
    HylaApplication,
    BlogRuntime,
    ArticleSummarizer,
    ProviderPanel,
    OpenAIv1,
    OpenAIv2,
    Claude,
  ],
})

console.log('\n=== Hyla / BASM-style demo ===')
console.log('Automatically discovered package versions:', {
  openAiLegacy: OpenAIv1.version,
  openAiCurrent: OpenAIv2.version,
  claude: Claude.version,
  postgres: Postgres.version,
})

const appEnv = await runtime.enter(AppEntry, {
  database: {
    connectionString: 'postgres://demo@localhost/hyla',
    applicationName: 'hyla-demo',
  },
})

const app = await appEnv.deps.app.load()
console.log('Application status:', await app.status())

const blogEnv = await appEnv.enter(BlogEntry, {
  currentBlog: {
    id: 'blog-42',
    title: 'Scope-Aware Systems',
  },
  summaryLlm: ArticleSummaryLlm.to(OpenAIv2),
})

const blog = await blogEnv.deps.blog.load()
console.log('Blog world:', await blog.describe())
console.log('Blog reuses root PostgreSQL pool:', await blog.databasePool())

const requestA = await blogEnv.enter(RequestEntry, {
  call: { requestId: 'request-a', blogId: 'blog-42' },
})
const requestB = await blogEnv.enter(RequestEntry, {
  call: { requestId: 'request-b', blogId: 'blog-42' },
})

const summarizerA = await requestA.deps.summarizer.load()
const summarizerB = await requestB.deps.summarizer.load()
console.log('Request A provider:', await summarizerA.provider())
console.log('Request B provider:', await summarizerB.provider())
console.log(await summarizerA.summarize('Canonical slots make derived worlds predictable.'))
console.log(await summarizerB.summarize('Bindings preserve a user-selected implementation.'))
console.log('Request-local summarizers are distinct:', summarizerA !== summarizerB)

await requestA.dispose()
await requestB.dispose()

await blogEnv.run(
  ProvidersEntry,
  { call: { requestId: 'provider-panel', blogId: 'blog-42' } },
  async ({ panel }) => {
    const providerPanel = await panel.load()
    const candidates = await providerPanel.list()
    console.log('Selector exposes every admitted implementation revision:')
    for (const candidate of candidates) {
      console.log(`  - ${candidate.familyMetadata.displayName} @ ${candidate.version}`)
    }

    const legacyOpenAi = candidates.find(
      candidate => candidate.familyId === OpenAIv1.family.id
        && candidate.version === OpenAIv1.version,
    )
    if (!legacyOpenAi) throw new Error('Expected OpenAI v1 candidate.')
    console.log(
      await providerPanel.run(
        legacyOpenAi.persistentRef,
        'Run a provider selected from the canonical selector slot.',
      ),
    )
  },
)

console.log(
  'Runtime catalog (no Env topology required):',
  runtime.catalog.implementations(LlmConnector).map(item =>
    `${item.familyMetadata.displayName}@${item.version}`,
  ),
)
console.log('Runtime admission/internal split:', runtime.inspect())

await appEnv.dispose()
await runtime.dispose()

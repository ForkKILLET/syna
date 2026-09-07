import assert from 'node:assert/strict'
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
const status = await app.status()
console.log('Application status:', status)

const blogEnv = await appEnv.enter(BlogEntry, {
  currentBlog: {
    id: 'blog-42',
    title: 'Scope-Aware Systems',
  },
  summaryLlm: ArticleSummaryLlm.to(OpenAIv2),
})

const blog = await blogEnv.deps.blog.load()
const blogDescription = await blog.describe()
const blogPool = await blog.databasePool()
console.log('Blog world:', blogDescription)
console.log('Blog reuses root PostgreSQL pool:', blogPool)

const requestA = await blogEnv.enter(RequestEntry, {
  call: { requestId: 'request-a', blogId: 'blog-42' },
})
const requestB = await blogEnv.enter(RequestEntry, {
  call: { requestId: 'request-b', blogId: 'blog-42' },
})

const summarizerA = await requestA.deps.summarizer.load()
const summarizerB = await requestB.deps.summarizer.load()
const providerA = await summarizerA.provider()
const providerB = await summarizerB.provider()
const summaryA = await summarizerA.summarize('Canonical slots make derived worlds predictable.')
const summaryB = await summarizerB.summarize('Bindings preserve a user-selected implementation.')
console.log('Request A provider:', providerA)
console.log('Request B provider:', providerB)
console.log(summaryA)
console.log(summaryB)
console.log('Request-local summarizers are distinct:', summarizerA !== summarizerB)

await requestA.dispose()
await requestB.dispose()

const panel = await blogEnv.run(
  ProvidersEntry,
  { call: { requestId: 'provider-panel', blogId: 'blog-42' } },
  async ({ panel }) => {
    const providerPanel = await panel.load()
    const candidates = await providerPanel.list()
    console.log('C.all exposes every admitted implementation revision:')
    for (const candidate of candidates) {
      console.log(`  - ${candidate.familyMetadata.displayName} @ ${candidate.version}`)
    }

    const legacyOpenAi = candidates.find(
      candidate => candidate.familyId === OpenAIv1.family.id
        && candidate.version === OpenAIv1.version,
    )
    if (!legacyOpenAi) throw new Error('Expected OpenAI v1 candidate.')
    const completion = await providerPanel.run(
      legacyOpenAi.implementationRef,
      'Run a provider chosen from the admitted set.',
    )
    console.log(completion)
    return {
      candidates: candidates.map(candidate => `${candidate.familyId}@${candidate.version}`).sort(),
      completion,
    }
  },
)

const catalog = runtime.catalog.implementations(LlmConnector).map(item =>
  `${item.familyMetadata.displayName}@${item.version}`,
)
console.log('Runtime catalog (no Env topology required):', catalog)
console.log('Runtime admission/internal split:', runtime.inspect())

await appEnv.dispose()
const liveEnvs = runtime.inspect().liveEnvCount
await runtime.dispose()

// The demo checks what it printed (I-112): one pool shared down the Env tree, the Binding's
// choice honoured per request world, every admitted LlmConnector revision visible through C.all.
assert.deepEqual(status, { databasePool: blogPool, databaseUrl: 'postgres://demo@localhost/hyla' })
assert.equal(blogDescription, 'Scope-Aware Systems (blog-42)')
assert.equal(providerA, 'OpenAI')
assert.equal(providerB, 'OpenAI')
assert.equal(summaryA, `[openai@${OpenAIv2.version} request=request-a] Summarize for Scope-Aware Systems (request-a): Canonical slots make derived worlds predictable.`)
assert.equal(summaryB, `[openai@${OpenAIv2.version} request=request-b] Summarize for Scope-Aware Systems (request-b): Bindings preserve a user-selected implementation.`)
assert.notEqual(summarizerA, summarizerB)
assert.deepEqual(panel.candidates, [OpenAIv1, OpenAIv2, Claude].map(revision => `${revision.family.id}@${revision.version}`).sort())
assert.equal(panel.completion, `[openai@${OpenAIv1.version} request=provider-panel] Run a provider chosen from the admitted set.`)
assert.equal(catalog.length, 3)
assert.equal(liveEnvs, 0)
console.log('demo: OK')

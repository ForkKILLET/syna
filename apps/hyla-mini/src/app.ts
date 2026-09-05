import { createRuntime, type CreateRuntimeOptions, type EnvHandle, type ServiceRevision, type SynaRuntime } from '@syna/core'
import { AUTHENTICATORS } from './auth/implementations.js'
import { DatabasePool } from './data/postgres/pool.js'
import { PostgresContentStore } from './data/postgres/store.js'
import { FilesystemContentStore } from './data/filesystem/store.js'
import { BlogLayout, ContentLayoutChoice, DefaultLayout } from './data/filesystem/layout.js'
import { ContentBackend } from './domain/content.js'
import type { DatabaseSettings } from './data/postgres/config.js'
import { PipelineBuilder } from './render/pipeline.js'
import { Renderer } from './render/renderer.js'
import { STAGE_FACTORIES } from './render/factories.js'
import { MarkdownStageFactoryContract } from './render/stages.js'
import { RenderInfrastructureEntry } from './render/infrastructure.js'
import { SiteContext } from './site/context.js'
import { FilesystemInfrastructureEntry, PostgresInfrastructureEntry, RequestEntry, SiteEntry } from './site/entries.js'
import { AppEntry } from './site/app-entry.js'
import { SiteEnvironmentManager } from './site/manager.js'
import { RequestHandler } from './site/request.js'
import { StaticBuilder } from './site/static-builder.js'
import { MaintenanceWorker } from './site/worker.js'
import type { RequestFacts, SiteManagerSettings } from './site/inputs.js'
import { evaluateBudget, type BudgetReport, type ForkBudget } from './site/preflight.js'
import { loadDomainTable, type DomainTable } from './site/domains.js'
import { defaultRecipes } from './render/recipe.js'
import { SessionAuth } from './auth/implementations.js'
import { SiteAuth } from './auth/contract.js'

export type BackendChoice =
  | { readonly kind: 'postgres'; readonly database: DatabaseSettings }
  | { readonly kind: 'filesystem'; readonly rootDir: string; readonly layout?: 'default' | 'blog' }

export interface HylaAppOptions {
  readonly backend: BackendChoice
  readonly siteManager?: Partial<SiteManagerSettings>
  /** Additional admitted Services (third-party factories, alternative authenticators, fixtures). */
  readonly extraServices?: readonly ServiceRevision[]
  readonly runtime?: Omit<CreateRuntimeOptions, 'services'>
}

export interface HylaApp {
  readonly runtime: SynaRuntime
  readonly infrastructure: EnvHandle<any>
  readonly app: EnvHandle<typeof AppEntry['requires']>
  readonly preflight: readonly BudgetReport[]
  domains(): Promise<DomainTable>
  close(): Promise<void>
}

/** Default budget for one request: only the request handler may be local; shared infrastructure must be inherited. */
export const REQUEST_BUDGET: ForkBudget = Object.freeze({
  maxLocalServices: 10,
  mustInherit: Object.freeze([
    `service:${PipelineBuilder.key}`,
    `service:${Renderer.key}`,
    `service:${SiteContext.key}`,
    ...STAGE_FACTORIES.map(factory => `service:${factory.key}`),
  ]),
  costs: Object.freeze({ [DatabasePool.key]: 10, [PostgresContentStore.key]: 10, [FilesystemContentStore.key]: 5 }),
  maxCost: 10,
})

export const SITE_BUDGET: ForkBudget = Object.freeze({
  maxLocalServices: 4,
  mustInherit: Object.freeze([
    `service:${PipelineBuilder.key}`,
    `service:${Renderer.key}`,
    ...STAGE_FACTORIES.map(factory => `service:${factory.key}`),
  ]),
})

export const CORE_SERVICES: readonly ServiceRevision[] = Object.freeze([
  DatabasePool,
  PostgresContentStore,
  FilesystemContentStore,
  DefaultLayout,
  BlogLayout,
  ...STAGE_FACTORIES,
  PipelineBuilder,
  Renderer,
  SiteContext,
  RequestHandler,
  StaticBuilder,
  SiteEnvironmentManager,
  MaintenanceWorker,
  ...AUTHENTICATORS,
])

export class PreflightError extends Error {
  readonly reports: readonly BudgetReport[]
  constructor(reports: readonly BudgetReport[]) {
    super(`Deployment refused by preflight:\n${reports.flatMap(report => report.violations.map(violation => `  [${report.entry}] ${violation}`)).join('\n')}`)
    this.name = 'PreflightError'
    this.reports = reports
  }
}

/**
 * Host wiring: Runtime → infrastructure root → app Env, with startup preflight.
 * The render infrastructure (including the whole factory collection) and the
 * site/request shapes are explained and budget-checked before anything listens.
 */
export async function createHylaApp(options: HylaAppOptions): Promise<HylaApp> {
  const runtime = createRuntime({
    ...options.runtime,
    services: [...CORE_SERVICES, ...(options.extraServices ?? [])],
  })
  const reports: BudgetReport[] = []
  const refuse = async (): Promise<never> => {
    await runtime.dispose()
    throw new PreflightError(reports)
  }

  // 1. Render infrastructure must plan with only public infrastructure; any factory needing request/site facts fails here.
  const infrastructureExplanation = await runtime.explain(RenderInfrastructureEntry)
  reports.push(evaluateBudget(infrastructureExplanation, { maxLocalServices: Number.POSITIVE_INFINITY, mustInherit: [] }))
  if (!reports.at(-1)!.ok) return refuse()

  let infrastructure: EnvHandle<any>
  let backend
  if (options.backend.kind === 'postgres') {
    infrastructure = await runtime.enter(PostgresInfrastructureEntry, { database: options.backend.database })
    backend = ContentBackend.to(PostgresContentStore)
  }
  else {
    infrastructure = await runtime.enter(FilesystemInfrastructureEntry, {
      contentRoot: { rootDir: options.backend.rootDir },
      layout: ContentLayoutChoice.to(options.backend.layout === 'blog' ? BlogLayout : DefaultLayout),
    })
    backend = ContentBackend.to(FilesystemContentStore)
  }
  const appParameters = { backend, siteManager: options.siteManager ?? {} }

  // 2. The app world plans; then the site and request shapes are budget-checked from a planned app world.
  const appCheck = await infrastructure.check(AppEntry, appParameters)
  if (!appCheck.ok) {
    await runtime.dispose()
    throw new Error(`App entry does not plan: ${appCheck.error.code} ${appCheck.error.message}`)
  }
  const app = await infrastructure.enter(AppEntry, appParameters)
  const probeSite = {
    tenantId: 'preflight',
    title: 'preflight',
    domains: [],
    defaultLocale: 'en' as const,
    theme: { name: 'paper', accent: '#000000' },
    navigation: [],
    recipes: defaultRecipes(),
    auth: { implementation: SiteAuth.to(SessionAuth), options: {} },
    configRevision: 1,
  }
  const siteExplanation = await app.explain(SiteEntry, {
    tenant: 'preflight',
    snapshot: probeSite,
    auth: SiteAuth.to(SessionAuth),
    authOptions: {},
  })
  reports.push(evaluateBudget(siteExplanation, SITE_BUDGET))
  if (!reports.at(-1)!.ok) return refuse()

  return {
    runtime,
    infrastructure,
    app,
    preflight: reports,
    domains: async () => loadDomainTable(await app.deps.store.load()),
    async close() {
      await runtime.dispose()
    },
  }
}

export const PROBE_REQUEST: RequestFacts = Object.freeze({
  method: 'GET',
  path: '/',
  query: Object.freeze({}),
  host: 'preflight.test',
  headers: Object.freeze({}),
  principal: Object.freeze({ kind: 'anonymous' as const }),
  target: 'http' as const,
})

/** Explains one request from a live site Env and evaluates the request budget. Planning only. */
export async function explainRequest(
  siteEnv: EnvHandle<typeof SiteEntry['requires']>,
  facts: RequestFacts = PROBE_REQUEST,
  budget: ForkBudget = REQUEST_BUDGET,
): Promise<BudgetReport> {
  const explanation = await siteEnv.explain(RequestEntry, { request: facts })
  return evaluateBudget(explanation, budget)
}

/**
 * Request-budget preflight for every known tenant: acquires each SiteEnv once,
 * explains a probe request against the request budget, releases the lease.
 * Run before the server listens; a violation refuses the deployment.
 */
export async function preflightRequests(app: HylaApp, tenantIds?: readonly string[]): Promise<readonly BudgetReport[]> {
  const store = await app.app.deps.store.load()
  const manager = await app.app.deps.sites.load()
  const tenants = tenantIds ?? await store.listTenants()
  const reports: BudgetReport[] = []
  for (const tenantId of tenants) {
    const lease = await manager.acquire(tenantId, 'background')
    try {
      reports.push(await explainRequest(lease.env))
    }
    finally {
      lease.release()
    }
  }
  if (reports.some(report => !report.ok)) throw new PreflightError(reports)
  return reports
}

export { MarkdownStageFactoryContract }

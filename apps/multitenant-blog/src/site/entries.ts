import { define } from '../syna.js'
import { ContentLayoutChoice } from '../data/filesystem/layout.js'
import { ContentRoot } from '../data/filesystem/config.js'
import { DatabaseConfig } from '../data/postgres/config.js'
import { AuthOptions, SiteAuth } from '../auth/contract.js'
import { SiteContext } from './context.js'
import { RequestHandler } from './request.js'
import { BuildOptions, CurrentRequest, SiteSnapshot, TenantId } from './inputs.js'
import { StaticBuilder } from './static-builder.js'

/** Root of a PostgreSQL deployment: supplies the shared database settings. */
export const PostgresInfrastructureEntry = define.entry('postgres-infrastructure', {
  parameters: { database: DatabaseConfig },
})

/** Root of a filesystem deployment: supplies the content root and layout choice. */
export const FilesystemInfrastructureEntry = define.entry('filesystem-infrastructure', {
  parameters: { contentRoot: ContentRoot, layout: ContentLayoutChoice },
})

/** One tenant × one configuration revision. Created on demand by the manager, never per request. */
export const SiteEntry = define.entry('site', {
  requires: { context: SiteContext, auth: SiteAuth },
  parameters: { tenant: TenantId, snapshot: SiteSnapshot, auth: SiteAuth, authOptions: AuthOptions },
})

/** One HTTP request (or one static page render). */
export const RequestEntry = define.entry('request', {
  requires: { handler: RequestHandler },
  parameters: { request: CurrentRequest },
})

/** One static build of a site. */
export const BuildEntry = define.entry('build', {
  requires: { builder: StaticBuilder },
  parameters: { build: BuildOptions },
})

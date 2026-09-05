// Detail dump for the two R17 expectation checks that failed in 01-cache-neutrality.probe.mjs:
//  (1) Layer re-providing Region (same payload) — which nodes fork, with explain() causes
//  (2) share:[Cache] while re-providing Tenant — what error (if any) enter()/explain() produce
import { createRuntime, definePackage } from '../../../packages/core/dist/index.js'

const pkg = (id, version = '1.0.0') => definePackage({ name: `@audit/${id.replaceAll('.', '-')}`, version, syna: { id } })
const d = pkg('audit.cd2')
const Tenant = d.input('tenant')
const Region = d.input('region')
const Request = d.input('request')
const Capability = d.contract('capability')
const ProviderA = pkg('audit.cd2.a').service({ provides: [Capability], setup: () => ({}) })
const Logger = d.service('logger', { setup: () => ({}) })
const Pool = d.service('pool', { requires: { logger: Logger }, setup: () => ({}) })
const Cache = d.service('cache', { requires: { tenant: Tenant, pool: Pool }, setup: ({ tenant }) => ({ tenant: tenant.read() }) })
const Panel = d.service('panel', { requires: { all: Capability.all, region: Region }, setup: () => ({}) })
const RequestAware = d.service('request-aware', { requires: { request: Request, cache: Cache }, setup: () => ({}) })
const App = d.entry('app', { requires: { pool: Pool } })
const Site = d.entry('site', { requires: { cache: Cache, panel: Panel }, parameters: { tenant: Tenant, region: Region } })
const Layer = d.entry('layer', { requires: {}, parameters: { region: Region } })
const ReqBadShare = d.entry('request-bad-share', { requires: { aware: RequestAware }, parameters: { request: Request, tenant: Tenant }, scope: { share: [Cache] } })
const ReqShareOk = d.entry('request-share-ok', { requires: { aware: RequestAware }, parameters: { request: Request }, scope: { share: [Cache] } })

const runtime = createRuntime({ services: [Logger, Pool, Cache, Panel, RequestAware, ProviderA] })
const app = await runtime.enter(App)
const site = await app.enter(Site, { tenant: 'a', region: 'eu' })
const role = new Map([[app.id, 'app'], [site.id, 'site']])
const show = (env) => env.inspect().nodes.map(n => `${n.nodeId} -> ${role.get(n.ownerEnvId) ?? (n.ownerEnvId === env.id ? 'SELF' : n.ownerEnvId)}`).join('\n  ')
const showExplain = (x) => x.ok
  ? x.nodes.map(n => `${n.nodeId}: ${n.disposition}${n.cause ? ` cause=${JSON.stringify(n.cause)}` : ''} path=${JSON.stringify(n.path)}`).join('\n  ')
  : `NOT OK code=${x.error.code} message=${x.error.message} details=${JSON.stringify(x.error.details)}`

console.log('=== (1) Layer re-providing Region with the same payload ===')
console.log('explain:\n  ' + showExplain(await site.explain(Layer, { region: 'eu' })))
const layer = await site.enter(Layer, { region: 'eu' })
console.log('inspect:\n  ' + show(layer))
console.log('spec K03/R16: explicit Input re-provision is a new slot even with the same payload; Panel depends on Region so Panel must fork; Cache does not depend on Region and must be inherited.')
await layer.dispose()

console.log('\n=== (2) share:[Cache] while the Entry re-provides Tenant (Cache depends on Tenant) ===')
console.log('explain:\n  ' + showExplain(await site.explain(ReqBadShare, { request: 1, tenant: 'other' })))
try { const env = await site.enter(ReqBadShare, { request: 1, tenant: 'other' }); console.log('enter: NO ERROR; nodes:\n  ' + show(env)); await env.dispose() }
catch (error) { console.log(`enter: threw code=${error.code} message=${error.message}\n  details=${JSON.stringify(error.details)}`) }

console.log('\n=== (2b) control: share:[Cache] without re-providing Tenant ===')
console.log('explain:\n  ' + showExplain(await site.explain(ReqShareOk, { request: 1 })))
const ok = await site.enter(ReqShareOk, { request: 1 })
console.log('inspect:\n  ' + show(ok))
await ok.dispose()
await runtime.dispose()

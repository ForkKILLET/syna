// K12 — does candidate backtracking hide candidate-independent failures?
// solvePlanTemplate() catches every code in BACKTRACKABLE_CODES while trying auto()/range candidates and,
// when all candidates fail, throws UNSATISFIABLE_TOPOLOGY "No candidate can satisfy auto(...)".
// If the failure has nothing to do with the choice (SHARE_CONSTRAINT_FAILED, MISSING_INPUT deeper in the
// graph), the reported code depends on whether an unresolved choice site happens to exist — and on the
// order of `requires` keys — and explain() then reports missingInputs: [] for a genuinely missing Input.
import assert from 'node:assert/strict'
import { auto, createRuntime, definePackage } from '../../../../packages/core/dist/index.js'

let failures = 0
const report = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) failures += 1 }
const checkAsync = async (name, fn) => { try { await fn(); report(name, true) } catch (error) { report(name, false, error instanceof Error ? error.message.split('\n').slice(0, 3).join(' / ') : String(error)) } }
const pkg = (id, version = '1.0.0') => definePackage({ name: `@audit/${id.replaceAll('.', '-')}`, version, syna: { id } })

const d = pkg('audit.wrap')
const Request = d.input('request')
const Tenant = d.input('tenant')
const Capability = d.contract('capability')
const P1 = pkg('audit.wrap.p1').service({ provides: [Capability], setup: () => ({}) })
const P2 = pkg('audit.wrap.p2').service({ provides: [Capability], setup: () => ({}) })
const Pool = d.service('pool', { setup: () => ({}) })
const Cache = d.service('cache', { requires: { tenant: Tenant, pool: Pool }, setup: () => ({}) })
const NeedsRequest = d.service('needs-request', { requires: { request: Request }, setup: () => ({}) })
const AutoUser = d.service('auto-user', { requires: { automatic: auto(Capability) }, setup: () => ({}) })
const App = d.entry('app', { requires: { pool: Pool } })
const Site = d.entry('site', { requires: { cache: Cache }, parameters: { tenant: Tenant } })
// share violation, with and without an unresolved auto() site in the same graph
const ShareOnly = d.entry('share-only', { requires: { cache: Cache }, parameters: { tenant: Tenant }, scope: { share: [Cache] } })
const ShareWithAuto = d.entry('share-with-auto', { requires: { automatic: AutoUser, cache: Cache }, parameters: { tenant: Tenant }, scope: { share: [Cache] } })
// missing Input deeper in the graph (Request is never provided), auto site declared before / after the needy root
const MissingOnly = d.entry('missing-only', { requires: { needy: NeedsRequest } })
const MissingAutoFirst = d.entry('missing-auto-first', { requires: { automatic: AutoUser, needy: NeedsRequest } })
const MissingAutoLast = d.entry('missing-auto-last', { requires: { needy: NeedsRequest, automatic: AutoUser } })

const policy = { orderAutoCandidates: (_c, candidates) => [...candidates].sort((l, r) => l.family.id.localeCompare(r.family.id)) }
const runtime = createRuntime({ services: [Pool, Cache, NeedsRequest, AutoUser, P1, P2], policy })
const app = await runtime.enter(App)
const site = await app.enter(Site, { tenant: 'a' })

const codeOf = async (fn) => { try { await fn(); return 'NO-ERROR' } catch (error) { return error.code } }
const summarize = (explanation) => explanation.ok ? 'OK' : `${explanation.error.code} missingInputs=${JSON.stringify(explanation.missingInputs)} nested=${JSON.stringify((explanation.error.details.failures ?? []).map(f => f.code))}`

const shareOnly = await site.explain(ShareOnly, { tenant: 'b' })
const shareWithAuto = await site.explain(ShareWithAuto, { tenant: 'b' })
console.log(`share-only:      enter=${await codeOf(() => site.enter(ShareOnly, { tenant: 'b' }))} explain=${summarize(shareOnly)}`)
console.log(`share-with-auto: enter=${await codeOf(() => site.enter(ShareWithAuto, { tenant: 'b' }))} explain=${summarize(shareWithAuto)}`)
const missingOnly = await app.explain(MissingOnly)
const missingAutoFirst = await app.explain(MissingAutoFirst)
const missingAutoLast = await app.explain(MissingAutoLast)
console.log(`missing-only:       enter=${await codeOf(() => app.enter(MissingOnly))} explain=${summarize(missingOnly)}`)
console.log(`missing-auto-first: enter=${await codeOf(() => app.enter(MissingAutoFirst))} explain=${summarize(missingAutoFirst)}`)
console.log(`missing-auto-last:  enter=${await codeOf(() => app.enter(MissingAutoLast))} explain=${summarize(missingAutoLast)}`)

await checkAsync('K12 control: share violation without a choice site is SHARE_CONSTRAINT_FAILED', async () => assert.equal(shareOnly.error.code, 'SHARE_CONSTRAINT_FAILED'))
await checkAsync('K12 share violation with an unrelated unresolved auto() site keeps its own code (not UNSATISFIABLE_TOPOLOGY)', async () => assert.equal(shareWithAuto.error.code, 'SHARE_CONSTRAINT_FAILED', `got ${shareWithAuto.error.code}: ${shareWithAuto.error.message}`))
await checkAsync('K12 control: missing deep Input without a choice site is MISSING_INPUT and explain lists it', async () => { assert.equal(missingOnly.error.code, 'MISSING_INPUT'); assert.deepEqual(missingOnly.missingInputs, [Request.id]) })
await checkAsync('K12 missing deep Input with auto() declared first: explain() still reports the missing Input', async () => { assert.equal(missingAutoFirst.error.code, 'MISSING_INPUT', `got ${missingAutoFirst.error.code}`); assert.deepEqual(missingAutoFirst.missingInputs, [Request.id]) })
await checkAsync('K12 missing deep Input with auto() declared last: explain() reports the missing Input', async () => { assert.equal(missingAutoLast.error.code, 'MISSING_INPUT', `got ${missingAutoLast.error.code}`); assert.deepEqual(missingAutoLast.missingInputs, [Request.id]) })
await checkAsync('K12 the diagnosis does not depend on the declaration order of unrelated requires keys', async () => assert.equal(missingAutoFirst.error.code, missingAutoLast.error.code))

await runtime.dispose()
console.log(`${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)

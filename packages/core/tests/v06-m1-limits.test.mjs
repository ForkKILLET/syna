// M1 (v0.6): `limits: { setupDeadlineMs, disposalGraceMs, planningBudget, planCacheEntries }` replaces the four
// nested option records `initialization.deadlineMs`, `disposal.graceMs`, `planning.searchBudget` and
// `planCache.maxEntries` (reason 3: four one-key records for one concept). The old records stay as deprecated
// aliases until 0.7.0; the defaults are locked verbatim; each old key maps to exactly one limit.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRuntime, definePackage } from '../dist/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@v06/${id}-${version.replaceAll('.', '-')}`, version, syna: { id } })

const DEFAULTS = { setupDeadlineMs: '30_000', disposalGraceMs: '2_000', planningBudget: '10_000', planCacheEntries: '512' }

test('M1 the defaults are locked verbatim: 30_000 / 2_000 / 10_000 / 512', async () => {
  const source = readFileSync(path.join(root, 'packages/core/src/runtime.ts'), 'utf8')
  for (const line of [
    `const DEFAULT_SETUP_DEADLINE_MS = ${DEFAULTS.setupDeadlineMs}`,
    `const DEFAULT_DISPOSAL_GRACE_MS = ${DEFAULTS.disposalGraceMs}`,
    `const DEFAULT_PLANNING_BUDGET = ${DEFAULTS.planningBudget}`,
    `const DEFAULT_PLAN_CACHE_ENTRIES = ${DEFAULTS.planCacheEntries}`,
  ]) assert.ok(source.includes(`\n${line}\n`), `runtime.ts must declare ${line}`)
  const declaration = readFileSync(path.join(root, 'packages/core/dist/descriptors.d.ts'), 'utf8')
  assert.ok(declaration.includes(`Defaults: \`setupDeadlineMs\` ${DEFAULTS.setupDeadlineMs}, \`disposalGraceMs\` ${DEFAULTS.disposalGraceMs},\n * \`planningBudget\` ${DEFAULTS.planningBudget}, \`planCacheEntries\` ${DEFAULTS.planCacheEntries}.`), 'RuntimeLimits documents the defaults')
  const reference = readFileSync(path.join(root, 'docs/API_REFERENCE.md'), 'utf8')
  assert.ok(reference.includes(`limits: { setupDeadlineMs: ${DEFAULTS.setupDeadlineMs}, disposalGraceMs: ${DEFAULTS.disposalGraceMs}, planningBudget: ${DEFAULTS.planningBudget}, planCacheEntries: ${DEFAULTS.planCacheEntries} },`), 'API_REFERENCE shows the defaults')
  const runtime = createRuntime({ services: [] })
  assert.equal(runtime.inspect().planCache.maxEntries, 512, 'the observable default')
  await runtime.dispose()
})

const stuckWorld = () => {
  const define = makeDefine('m1-stuck')
  const Stuck = define.service('stuck', { setup: () => new Promise(() => {}) })
  return { Stuck, Entry: define.entry('entry', { requires: { stuck: Stuck } }) }
}

test('M1 each old nested record maps to exactly one limit with identical behaviour', async () => {
  for (const options of [{ limits: { planCacheEntries: 3 } }, { planCache: { maxEntries: 3 } }]) {
    const runtime = createRuntime({ services: [], ...options })
    assert.equal(runtime.inspect().planCache.maxEntries, 3)
    await runtime.dispose()
  }

  for (const options of [{ limits: { setupDeadlineMs: 30, disposalGraceMs: 10 } }, { initialization: { deadlineMs: 30 }, disposal: { graceMs: 10 } }]) {
    const { Stuck, Entry } = stuckWorld()
    const runtime = createRuntime({ services: [Stuck], ...options })
    const env = await runtime.enter(Entry)
    await assert.rejects(env.deps.stuck.load(), error => error.code === 'INITIALIZATION_TIMEOUT' && error.details.deadlineMs === 30)
    await env.dispose().catch(() => undefined)
    await runtime.dispose().catch(() => undefined)
  }

  for (const options of [{ limits: { disposalGraceMs: 20 } }, { disposal: { graceMs: 20 } }]) {
    const { Stuck, Entry } = stuckWorld()
    const runtime = createRuntime({ services: [Stuck], ...options })
    const env = await runtime.enter(Entry)
    void env.deps.stuck.load().catch(() => undefined)
    const started = Date.now()
    // dispose() reports the abandoned attempt (directly or inside the AggregateError of a partial close).
    await assert.rejects(env.dispose(), error => error.code === 'UNSETTLED_ATTEMPT' || (error.errors ?? []).some(inner => inner.code === 'UNSETTLED_ATTEMPT'))
    assert.ok(Date.now() - started < 1_000, 'the close is bounded by the grace, not by the setup deadline')
    assert.equal(runtime.inspect().unsettledAttempts.length, 1)
    await runtime.dispose().catch(() => undefined)
  }

  // Budget: the v05-explain world that needs more than two candidate expansions.
  const define = makeDefine('m1-budget')
  const Needed = define.input('needed')
  const Cap = define.contract('cap')
  const providers = Array.from({ length: 6 }, (_, index) => makeDefine(`m1-budget-p${index}`).service({ provides: [Cap], requires: { needed: Needed }, setup: () => ({}) }))
  const Fixed1 = makeDefine('m1-budget-fixed', '1.0.0').service({ uniqueWithin: 'lineage', setup: () => ({}) })
  const Fixed2 = makeDefine('m1-budget-fixed', '2.0.0').service({ uniqueWithin: 'lineage', setup: () => ({}) })
  const Pick1 = makeDefine('m1-budget-pick1').service({ provides: [Cap], requires: { fixed: Fixed1 }, setup: () => ({}) })
  const Pick2 = makeDefine('m1-budget-pick2').service({ provides: [Cap], requires: { fixed: Fixed2 }, setup: () => ({}) })
  const Consumer = define.service('consumer', { requires: { a: { kind: 'auto-implementation', contract: Cap }, b: { kind: 'auto-implementation', contract: Cap } }, setup: () => ({}) })
  const BudgetEntry = define.entry('budget', { requires: { consumer: Consumer, fixed: Fixed2 } })
  const policy = { orderAutoCandidates: (_c, candidates) => [...candidates].sort((l, r) => l.key.localeCompare(r.key)) }
  const outcomes = []
  for (const options of [{ limits: { planningBudget: 2 } }, { planning: { searchBudget: 2 } }]) {
    const tight = createRuntime({ services: [Consumer, Pick1, Pick2, Fixed1, Fixed2, ...providers], policy, ...options })
    await assert.rejects(tight.check(BudgetEntry), error => { outcomes.push([error.code, error.details.budget]); return true })
    await tight.dispose()
  }
  assert.deepEqual(outcomes, [['PLANNING_BUDGET_EXCEEDED', 2], ['PLANNING_BUDGET_EXCEEDED', 2]])
})

test('M1 a limit given in both forms is refused; invalid values are refused under the new name', () => {
  const pairs = [
    [{ limits: { setupDeadlineMs: 1 } }, { initialization: { deadlineMs: 1 } }, 'setupDeadlineMs', 'initialization.deadlineMs'],
    [{ limits: { disposalGraceMs: 1 } }, { disposal: { graceMs: 1 } }, 'disposalGraceMs', 'disposal.graceMs'],
    [{ limits: { planningBudget: 1 } }, { planning: { searchBudget: 1 } }, 'planningBudget', 'planning.searchBudget'],
    [{ limits: { planCacheEntries: 1 } }, { planCache: { maxEntries: 1 } }, 'planCacheEntries', 'planCache.maxEntries'],
  ]
  for (const [modern, legacy, key, legacyName] of pairs) {
    assert.throws(() => createRuntime({ services: [], ...modern, ...legacy }), { name: 'TypeError', message: `createRuntime() received limits.${key} and its deprecated alias ${legacyName}; use limits.${key}.` })
    assert.doesNotThrow(() => createRuntime({ services: [], ...modern }))
    assert.doesNotThrow(() => createRuntime({ services: [], ...legacy }))
  }
  const invalid = [
    ['setupDeadlineMs', 0, { initialization: { deadlineMs: 0 } }, 'limits.setupDeadlineMs must be a positive number.'],
    ['disposalGraceMs', -1, { disposal: { graceMs: -1 } }, 'limits.disposalGraceMs must be a positive number.'],
    ['planningBudget', 0, { planning: { searchBudget: 0 } }, 'limits.planningBudget must be a positive safe integer.'],
    ['planCacheEntries', 1.5, { planCache: { maxEntries: 1.5 } }, 'limits.planCacheEntries must be a positive safe integer.'],
  ]
  for (const [key, value, legacy, message] of invalid) {
    assert.throws(() => createRuntime({ services: [], limits: { [key]: value } }), { name: 'TypeError', message })
    assert.throws(() => createRuntime({ services: [], ...legacy }), { name: 'TypeError', message })
  }
  assert.throws(() => createRuntime({ services: [], limits: 5 }), { name: 'TypeError', message: 'limits must be an object.' })
  assert.doesNotThrow(() => createRuntime({ services: [], limits: { setupDeadlineMs: Infinity } }), 'Infinity disables the deadline, as in 0.5')
})

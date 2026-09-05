// Documentation check for D35/D36 wording. SEMANTIC_MODEL §6 and API_REFERENCE say a range "resolves
// among the revisions of that Family the Runtime knows at the site (the admitted ones, the consumer's
// private closure, and the origin itself)". The code (graph-builder.ts, service-range case) filters
// visible revisions with realmAllows(): in the PUBLIC realm only admitted revisions qualify, the origin
// is NOT a candidate unless admitted. Both behaviours are probed: public root Entry vs Service-owned
// (private realm) Entry, same range, same non-admitted origin.
import { createRuntime } from '../../../../packages/core/dist/index.js'
import { check, main, makeDefine, settle } from './_harness.mjs'

await main(async () => {
  const define = makeDefine('audit3.range-origin')
  const Cap = define.contract('cap')
  const Private = makeDefine('audit3.range-origin.private', '1.0.0').service('helper', { provides: [Cap], setup: () => ({ v: '1.0.0' }) })

  // Public root Entry referencing the non-admitted origin by range only.
  const PublicEntry = define.entry('public', { requires: { helper: Private.range('*') } })
  // Service-owned Entry with the same range: its roots resolve in the owner's private realm.
  const OwnedEntry = define.entry('owned', { requires: { helper: Private.range('*') } })
  const Owner = define.service('owner', { requires: { owned: OwnedEntry }, setup: async ({ owned }) => ({ owned: await owned.load() }) })
  const Host = define.entry('host', { requires: { owner: Owner } })

  const runtime = createRuntime({ services: [Owner] })
  check('the origin is known to the Runtime (internal, not admitted)', runtime.inspect().internalServices.includes(Private.key) && !runtime.inspect().admittedServices.includes(Private.key), runtime.inspect().internalServices)
  const publicOutcome = await settle(runtime.enter(PublicEntry))
  check('public realm: a range whose origin is known but not admitted is refused (code: admitted only)', publicOutcome.status === 'rejected' && publicOutcome.error.code === 'MISSING_SERVICE', publicOutcome.status === 'rejected' ? publicOutcome.error : 'fulfilled')
  const publicExplain = await runtime.explain(PublicEntry)
  check('explain() agrees: MISSING_SERVICE for the public root', !publicExplain.ok && publicExplain.error.code === 'MISSING_SERVICE', publicExplain.ok ? 'ok' : publicExplain.error.code)

  const host = await runtime.enter(Host)
  const owner = await host.deps.owner.load()
  const child = await owner.owned.enter()
  const loaded = await child.deps.helper.load()
  check('private realm: the same range resolves to the origin (D35)', loaded.v === '1.0.0', loaded)
  await child.dispose()
  await host.dispose()
  await runtime.dispose()
  // Conclusion: the parenthetical "(…, and the origin itself)" in SEMANTIC_MODEL §6 / API_REFERENCE
  // holds only for a private realm; a public Entry sees admitted revisions only (SEMANTIC_CHANGES §7 says so).
})

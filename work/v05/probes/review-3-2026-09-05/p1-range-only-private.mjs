// C1: a private Family referenced only through range() must resolve for its owner and stay private.
import { createRuntime, definePackage } from '../../../../packages/core/dist/index.js'
const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@probe/${id.replaceAll('.', '-')}`, version, syna: { id } })
const define = makeDefine('probe3.range-only')
const Ledger = makeDefine('probe3.range-only.ledger').service('ledger', { setup: () => ({ version: '1.0.0' }) })
const LedgerEntry = define.entry('ledger', { requires: { ledger: Ledger.range('^1') } })
const Owner = define.service('owner', {
  requires: { entry: LedgerEntry },
  setup: ({ entry }) => ({ version: async () => (await entry.load()).run(async ({ ledger }) => (await ledger.load()).version) }),
})
const App = define.entry({ requires: { owner: Owner } })
const runtime = createRuntime({ services: [Owner] })
let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const app = await runtime.enter(App)
const version = await (await app.deps.owner.load()).version().catch(error => error)
check('range-only private Family resolves to its origin', version === '1.0.0', version?.code ?? version)
check('the origin is internal, not admitted', runtime.inspect().internalServices.includes(Ledger.key) && !runtime.inspect().admittedServices.includes(Ledger.key))
const pub = await app.enter(LedgerEntry).then(() => 'entered', error => error.code)
check('a public caller with the same descriptor is refused', pub === 'MISSING_SERVICE', pub)
await runtime.dispose()
process.exitCode = failed === 0 ? 0 : 1

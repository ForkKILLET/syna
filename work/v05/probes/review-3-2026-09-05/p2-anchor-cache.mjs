// C3: plan templates must not be shared between gap Envs that differ only in the lineage anchors they inherit.
import { createRuntime, definePackage } from '../../../../packages/core/dist/index.js'
const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@probe/${id.replaceAll('.', '-')}-${version}`, version, syna: { id } })
let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const build = () => {
  const define = makeDefine('probe3.anchors')
  const Cap = define.contract()
  const F1 = makeDefine('probe3.anchors.f', '1.0.0').service('f', { uniqueWithin: 'lineage', provides: [Cap], setup: () => ({ version: '1.0.0' }) })
  const F2 = makeDefine('probe3.anchors.f', '2.0.0').service('f', { uniqueWithin: 'lineage', provides: [Cap], setup: () => ({ version: '2.0.0' }) })
  const G = define.service('g', { provides: [Cap], setup: () => ({ version: 'g' }) })
  const Choice = define.binding('choice', Cap)
  const Pool = define.service('pool', { setup: () => ({}) })
  const Tenant = define.input('tenant')
  const Leaf = define.service('leaf', { requires: { f: F1.range('*') }, setup: async ({ f }) => ({ f: await f.load() }) })
  const App = define.entry('app', { requires: { impl: Choice }, parameters: { choice: Choice } })
  const Site = define.entry('site', { requires: { pool: Pool }, parameters: { tenant: Tenant, choice: Choice } })
  const Request = define.entry('request', { requires: { leaf: Leaf } })
  const runtime = createRuntime({ services: [F1, F2, G, Pool, Leaf] })
  const lineage = async anchored => {
    const app = await runtime.enter(App, { choice: anchored ? F1 : G })
    const site = await app.enter(Site, { tenant: anchored ? 'a' : 'b', choice: G })
    return { app, site }
  }
  const observe = async ({ site }) => {
    try {
      const request = await site.enter(Request)
      const version = (await request.deps.leaf.load()).f.version
      await request.dispose()
      return version
    }
    catch (error) { return error.code }
  }
  return { runtime, lineage, observe }
}
const expected = anchored => (anchored ? '1.0.0' : '2.0.0')
for (const order of [[true, false], [false, true]]) {
  const world = build()
  const lineages = new Map()
  for (const anchored of order) lineages.set(anchored, await world.lineage(anchored))
  const observed = {}
  for (const pass of [1, 2]) for (const anchored of order) observed[`${anchored ? 'anchored' : 'unanchored'}-${pass}`] = await world.observe(lineages.get(anchored))
  const ok = order.every(anchored => [1, 2].every(pass => observed[`${anchored ? 'anchored' : 'unanchored'}-${pass}`] === expected(anchored)))
  check(`${order.map(a => (a ? 'anchored' : 'unanchored')).join(' then ')}: both lineages plan as if cold in both passes`, ok, observed)
  await world.runtime.dispose()
}
process.exitCode = failed === 0 ? 0 : 1

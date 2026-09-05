// Attack 9: BoundEntry: OWNER_NOT_READY from eager setup (catchable); works after Ready; lazy setup in Ready owner; after owner disposal INVALID_ENV_STATE; anchor is owner not request child.
import { createRuntime } from '../../../packages/core/dist/index.js'
import { check, deferred, main, makeDefine, note, settle, sleep } from './_harness.mjs'

await main(async () => {
  const define = makeDefine('a9.bound')
  const Tx = define.service('tx', { setup(_d, { onDispose }) { return { tx: Math.random() } } })
  const Uow = define.entry('uow', { requires: { tx: Tx } })
  const attemptsFromSetup = []
  const App = define.service('app', {
    eager: true,
    requires: { uow: Uow },
    async setup({ uow }) {
      const handle = await uow.load()
      const early = await settle(handle.enter())
      attemptsFromSetup.push(early)
      const checked = await settle(handle.check())
      attemptsFromSetup.push(checked)
      return { handle, id: Math.random() }
    },
  })
  const LazyApp = define.service('lazy-app', {
    requires: { uow: Uow },
    async setup({ uow }) {
      const handle = await uow.load()
      const env = await handle.enter()      // owner is Ready when a lazy setup runs
      const tx = await env.deps.tx.load()
      await env.dispose()
      return { handle, tx }
    },
  })
  const Root = define.entry('root', { requires: { app: App, lazyApp: LazyApp } })
  const Request = define.entry('request', { requires: { app: App, lazyApp: LazyApp } })
  const runtime = createRuntime({ services: [Tx, App, LazyApp] })
  const root = await runtime.enter(Root)
  check('eager setup: handle.enter() -> OWNER_NOT_READY (catchable, owner still became Ready)', attemptsFromSetup[0].error?.code === 'OWNER_NOT_READY' && root.state === 'ready', attemptsFromSetup[0].error)
  check('eager setup: handle.check() (planning only) is allowed while activating', attemptsFromSetup[1].status === 'fulfilled' && attemptsFromSetup[1].value.ok === true, attemptsFromSetup[1].value ?? attemptsFromSetup[1].error)
  const app = await root.deps.app.load()
  const child = await app.handle.enter()
  check('after Ready the same handle works; child parented at owner', child.state === 'ready' && child.inspect().parentId === root.id, child.inspect().parentId)
  await child.dispose()
  const lazyApp = await root.deps.lazyApp.load()
  check('lazy setup in Ready owner: enter() worked and produced tx', typeof lazyApp.tx.tx === 'number', lazyApp.tx)

  // Anchor: enter from a request child that inherits App.
  const request = await root.enter(Request)
  const appViaRequest = await request.deps.app.load()
  check('request child inherits the same App instance', appViaRequest === app, appViaRequest === app)
  const viaRequest = await appViaRequest.handle.enter()
  check('BoundEntry invoked via request child is anchored at the OWNER (root), not the request child', viaRequest.inspect().parentId === root.id, { parentId: viaRequest.inspect().parentId, root: root.id, request: request.id })
  await request.dispose()
  check('after request child disposed, the child created via the handle is still alive (anchored at root)', viaRequest.state === 'ready', viaRequest.state)
  await viaRequest.dispose()
  // A service first loaded FROM a request child: owner should still be the root (slot ownership), anchor root.
  {
    const d2 = makeDefine('a9.lazy-owner')
    const Tx2 = d2.service('tx', { setup: () => ({}) })
    const Uow2 = d2.entry('uow', { requires: { tx: Tx2 } })
    const Svc = d2.service('svc', { requires: { uow: Uow2 }, async setup({ uow }) { return { handle: await uow.load() } } })
    const Root2 = d2.entry('root', { requires: { svc: Svc } })
    const Req2 = d2.entry('req', { requires: { svc: Svc } })
    const rt2 = createRuntime({ services: [Tx2, Svc] })
    const r2 = await rt2.enter(Root2)
    const q2 = await r2.enter(Req2)
    const svc = await q2.deps.svc.load()   // first materialization happens through the request child
    const e2 = await svc.handle.enter()
    check('slot first loaded from request child: BoundEntry still anchored at slot owner (root)', e2.inspect().parentId === r2.id, { parentId: e2.inspect().parentId, root: r2.id, req: q2.id })
    await q2.dispose()
    check('request child disposal does not take the bound child down', e2.state === 'ready', e2.state)
    await rt2.dispose()
    check('root disposal disposes the bound child', e2.state === 'disposed', e2.state)
  }
  // After owner disposal
  const disposing = root.dispose()
  const duringDisposal = await settle(app.handle.enter())
  check('during owner disposal: enter() -> INVALID_ENV_STATE', duringDisposal.error?.code === 'INVALID_ENV_STATE', duringDisposal.error?.code)
  await disposing
  const afterDisposal = await settle(app.handle.enter())
  check('after owner disposal: enter() -> INVALID_ENV_STATE', afterDisposal.error?.code === 'INVALID_ENV_STATE', afterDisposal.error)
  const afterCheck = await settle(app.handle.check())
  check('after owner disposal: check() also rejects INVALID_ENV_STATE', afterCheck.error?.code === 'INVALID_ENV_STATE', afterCheck.error?.code ?? afterCheck.value)
  await runtime.dispose()
})

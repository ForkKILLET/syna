// Attack 5 + 6: override coherence (interface-preserving fake, violating fake, interface-breaking fake) and private realms.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { definePackage, override } from '@syna/core'
import {
  ANONYMOUS, AuthOptions, AuthenticatorContract, PipelineBuilder, PreflightError, Renderer, SessionAuth, SiteAuth, createHylaApp, define,
  preflightRequests, startHttpServer, violations,
} from '../../../../apps/hyla-mini/dist/index.js'
import { fetchText, seedApp } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => {
  failed += ok ? 0 : 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`}`)
}
const watchdog = setTimeout(() => { console.log('FAIL probe timed out'); process.exit(2) }, 90_000)
const settled = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }))
const codeOf = error => error?.code === 'ENTRY_ACTIVATION_FAILED' ? (error.details?.causeCode ?? error.cause?.code ?? error.code) : error?.code ?? error?.name

const rootDir = await mkdtemp(path.join(tmpdir(), 'hyla-audit-override-'))
try {
  // ---------------------------------------------------------------- 5a. interface-preserving fake renderer
  const FakeRenderer = define.service('audit-fake-renderer', {
    requires: { pipelines: PipelineBuilder },
    async setup({ pipelines }) {
      const real = await Renderer.setup({ pipelines }, { signal: new AbortController().signal, onDispose() {} })
      return {
        ...real,
        async renderPostPage(site, post) {
          const page = await real.renderPostPage(site, post)
          return { ...page, html: page.html.replace('</main>', '<!--AUDIT-FAKE-RENDERER--></main>') }
        },
      }
    },
  })
  const app = await createHylaApp({ backend: { kind: 'filesystem', rootDir, layout: 'blog' }, runtime: { overrides: [override(Renderer, FakeRenderer)] } })
  await seedApp(app)
  check('5a preflight ok with the fake', app.preflight.every(report => report.ok), app.preflight.map(report => report.violations))
  check('5a runtime.inspect().overriddenServices names the source', app.runtime.inspect().overriddenServices.includes(Renderer.key), app.runtime.inspect().overriddenServices)
  check('5a the fake is not an independent admitted candidate', !app.runtime.inspect().admittedServices.includes(FakeRenderer.key))
  const server = await startHttpServer({ app: app.app, domains: await app.domains() })
  const page = await fetchText(`${server.url}/posts/shared-slug`, { headers: { host: 'alpha.test' } })
  check('5a pages are rendered through the fake', page.status === 200 && /AUDIT-FAKE-RENDERER/.test(page.body), page.status)
  const nodes = app.app.inspect().nodes
  check('5a the slot keeps the source nominal identity in inspect()', nodes.some(node => node.nodeId === `service:${Renderer.key}`) && !nodes.some(node => node.nodeId.includes('audit-fake-renderer')))
  const requestReports = await preflightRequests(app)
  check('5a request budget still holds with the fake (renderer inherited)', requestReports.every(report => report.ok), requestReports.map(report => report.violations))
  await server.close()
  await app.close()

  // ---------------------------------------------------------------- 5b. site-fact-reading fake renderer refused at preflight
  const refused = await settled(createHylaApp({ backend: { kind: 'filesystem', rootDir, layout: 'blog' }, runtime: { overrides: [override(Renderer, violations.SiteAwareRenderer)] } }))
  const message = refused.ok ? '' : refused.error.message
  check('5b SiteAwareRenderer override refused with PreflightError', !refused.ok && refused.error instanceof PreflightError, refused.ok ? 'started' : refused.error.name)
  check('5b diagnostic carries MISSING_INPUT, the input and the dependency path', /MISSING_INPUT/.test(message) && /site-snapshot/.test(message) && /renderer@0\.1\.0\/dependency:snapshot/.test(message), message.slice(0, 300))
  if (refused.ok) await refused.value.close()

  // ---------------------------------------------------------------- 5c. interface-breaking fake (no authenticate()) — K11 says consumer interface compatibility must be checked
  const BrokenAuth = define.service('audit-broken-auth', { requires: { options: AuthOptions }, setup() { return { scheme: 'broken' } } })
  const broken = await settled(createHylaApp({ backend: { kind: 'filesystem', rootDir, layout: 'blog' }, runtime: { overrides: [override(SessionAuth, BrokenAuth)] } }))
  if (broken.ok) {
    const manager = await broken.value.app.deps.sites.load()
    const lease = await settled(manager.acquire('alpha', 'request'))
    const server2 = await startHttpServer({ app: broken.value.app, domains: await broken.value.domains() })
    const response = await fetchText(`${server2.url}/`, { headers: { host: 'alpha.test' } })
    check('5c interface-incompatible override is refused at startup or site creation, not on the tenant\'s first request', !lease.ok || response.status !== 500, { startup: 'ok', siteCreation: lease.ok ? 'ok' : codeOf(lease.error), firstRequest: response.status, body: response.body.slice(0, 100) })
    if (lease.ok) lease.value.release()
    await server2.close()
    await broken.value.close()
  }
  else {
    check('5c interface-incompatible override refused at startup', true, codeOf(broken.error))
  }

  // ---------------------------------------------------------------- 6. private realm
  const audit = definePackage({ name: '@audit/private', version: '1.0.0', syna: { id: 'audit.private' } })
  const PrivateHelper = audit.service('private-helper', { setup: () => ({ secret: 'helper-42' }) })
  const PrivateAuth = audit.service('private-auth', {
    provides: [AuthenticatorContract],
    setup: () => ({ scheme: 'private', async authenticate() { return ANONYMOUS } }),
  })
  const PrivateWorld = audit.entry('private-world', { requires: { helper: PrivateHelper } })
  const Owner = audit.service('owner', {
    requires: { worlds: PrivateWorld, auth: PrivateAuth },
    async setup({ worlds, auth }) { return { bound: await worlds.load(), scheme: (await auth.load()).scheme } },
  })
  const OwnerWorld = audit.entry('owner-world', { requires: { owner: Owner } })
  const app3 = await createHylaApp({ backend: { kind: 'filesystem', rootDir, layout: 'blog' }, extraServices: [Owner] })
  const inspection = app3.runtime.inspect()
  check('6 private-only services are internal, not admitted', inspection.internalServices.includes(PrivateAuth.key) && inspection.internalServices.includes(PrivateHelper.key) && !inspection.admittedServices.includes(PrivateAuth.key), { internal: inspection.internalServices.filter(key => key.startsWith('audit.')), admitted: inspection.admittedServices.filter(key => key.startsWith('audit.')) })
  const implementations = app3.runtime.catalog.implementations(AuthenticatorContract).map(item => item.familyId)
  check('6 catalog.implementations(Authenticator) excludes the private-only implementation', !implementations.includes(PrivateAuth.family.id), implementations)
  const ownerEnv = await app3.app.enter(OwnerWorld)
  const owner = await ownerEnv.deps.owner.load()
  check('6 owner reached its private exact dependency', owner.scheme === 'private')
  const inner = await owner.bound.enter()
  check('6 service-owned BoundEntry resolves its private root', (await inner.deps.helper.load()).secret === 'helper-42')
  const innerNodes = inner.inspect().nodes.filter(node => node.label === PrivateHelper.key)
  check('6 private root slot is owned inside the owner-anchored world, not by the app Env', innerNodes.length === 1 && innerNodes[0].ownerEnvId !== app3.app.id, innerNodes.map(node => ({ owner: node.ownerEnvId, appEnv: app3.app.id })))
  await inner.dispose()
  const publicCheck = await app3.app.check(PrivateWorld)
  check('6 public env.check() of the same Entry → MISSING_SERVICE', !publicCheck.ok && publicCheck.error.code === 'MISSING_SERVICE', publicCheck.ok ? 'ok' : publicCheck.error.code)
  const publicBind = await settled(app3.app.bind(PrivateWorld).enter())
  check('6 public env.bind().enter() → MISSING_SERVICE', !publicBind.ok && codeOf(publicBind.error) === 'MISSING_SERVICE', publicBind.ok ? 'entered' : codeOf(publicBind.error))
  const ownerPublic = await settled(ownerEnv.bind(PrivateWorld).enter())
  check('6 public bind() from the owner Env itself does not inherit the private realm', !ownerPublic.ok && codeOf(ownerPublic.error) === 'MISSING_SERVICE', ownerPublic.ok ? 'entered' : codeOf(ownerPublic.error))
  const publicExplain = await app3.app.explain(PrivateWorld)
  check('6 explain() reports the missing private service without leaking a candidate', !publicExplain.ok && publicExplain.error.code === 'MISSING_SERVICE', publicExplain.ok ? 'ok' : publicExplain.error.message.slice(0, 160))
  // a site configuration that points its SiteAuth Binding at the private-only authenticator
  const store3 = await app3.app.deps.store.load()
  const current = await store3.forTenant('alpha').getSiteConfig()
  await store3.forTenant('alpha').saveSiteConfig({ ...current, auth: { implementation: SiteAuth.to(PrivateAuth), options: {} } })
  const manager3 = await app3.app.deps.sites.load()
  const acquired = await settled(manager3.acquire('alpha', 'request'))
  const acquiredCode = acquired.ok ? 'ok' : `${codeOf(acquired.error)} ${acquired.error.message.slice(0, 160)}`
  check('6 SiteAuth Binding to a private-only implementation fails with MISSING_IMPLEMENTATION (no supplier substitution)', !acquired.ok && /MISSING_IMPLEMENTATION/.test(acquiredCode), acquiredCode)
  if (acquired.ok) acquired.value.release()
  check('6 the failed creation left no record behind', manager3.records().filter(record => record.tenantId === 'alpha').length === 0, manager3.records())
  await ownerEnv.dispose()
  await app3.close()
}
finally {
  await rm(rootDir, { recursive: true, force: true })
  clearTimeout(watchdog)
  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
  setTimeout(() => { console.log(`FAIL process still alive 5s after close: ${process.getActiveResourcesInfo()}`); process.exit(1) }, 5000).unref()
  process.exitCode = failed === 0 ? 0 : 1
}

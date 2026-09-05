// F-AP3-02: `isSafeHref` refuses protocol-relative `//host` but accepts the backslash spellings the WHATWG URL
// parser (every browser) treats the same way: `/\host`, `\\host`, `\/host` all resolve to `http://host/`.
// The store accepts such a navigation href and the rendered page carries it verbatim.
import { isSafeHref, startHttpServer } from '../../../../apps/hyla-mini/dist/index.js'
import { createFilesystemApp, fetchText } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }

const base = 'http://alpha.test/posts/hello'
for (const href of ['//evil.example/x', '/\\evil.example/x', '\\\\evil.example/x', '\\/evil.example/x']) {
  const resolved = new URL(href, base)
  const leaves = resolved.host !== 'alpha.test'
  const accepted = isSafeHref(href)
  check(`${JSON.stringify(href)}: resolves to ${resolved.origin}; isSafeHref must refuse an href that leaves the site`, !(leaves && accepted), { accepted, resolvesTo: resolved.href })
}

const harness = await createFilesystemApp()
let server
try {
  const store = await harness.app.app.deps.store.load()
  const alpha = store.forTenant('alpha')
  const current = await alpha.getSiteConfig()
  const saved = await alpha.saveSiteConfig({ ...current, navigation: [{ label: 'Home', href: '/\\evil.example/' }] }).then(config => config.configRevision, error => error.code ?? error.message)
  check('the store refuses a navigation href that resolves to another origin (expected INVALID_SITE_CONFIG)', saved === 'INVALID_SITE_CONFIG', saved)
  if (typeof saved === 'number') {
    server = await startHttpServer({ app: harness.app.app, domains: await harness.app.domains(), onError() {} })
    const page = await fetchText(`${server.url}/`, { headers: { host: 'alpha.test' } })
    const nav = /<nav>.*?<\/nav>/s.exec(page.body)?.[0]
    check('the rendered navigation does not carry the foreign-origin href', !(nav ?? '').includes('href="/\\evil.example/"'), nav)
  }
}
finally {
  await server?.close()
  await harness.close()
}
process.exitCode = failed === 0 ? 0 : 1

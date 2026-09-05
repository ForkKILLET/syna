// D1: fetch() cannot send a Host header, so a tenant chosen by host answers 404 to it; node:http with the header answers 200.
import { startHttpServer } from '../../../../apps/hyla-mini/dist/index.js'
import { createFilesystemApp, fetchText } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'
let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const harness = await createFilesystemApp()
let server
try {
  const domains = await harness.app.domains()
  server = await startHttpServer({ app: harness.app.app, domains, onError: () => undefined })
  const viaFetch = await fetch(`${server.url}/posts/shared-slug`, { headers: { host: 'alpha.test' } }).then(response => response.status).catch(error => error.message)
  console.log(`observation: fetch() with a Host header answers ${viaFetch} (the header is dropped by fetch; this is why the old demo printed 404)`)
  const viaHttp = await fetchText(`${server.url}/posts/shared-slug`, { headers: { host: 'alpha.test' } })
  check('node:http with the tenant host answers 200 with the tenant page', viaHttp.status === 200 && /Alpha/.test(viaHttp.body), viaHttp.status)
}
finally {
  await server?.close()
  await harness.close()
}
process.exitCode = failed === 0 ? 0 : 1

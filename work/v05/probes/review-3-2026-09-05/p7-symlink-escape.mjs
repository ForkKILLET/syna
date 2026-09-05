// T1: a symbolic link under the static output directory must neither be written through by the builder nor served by the static server.
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BuildEntry, startStaticServer } from '../../../../apps/hyla-mini/dist/index.js'
import { createFilesystemApp, fetchText } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'
let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const harness = await createFilesystemApp()
const outputDir = await mkdtemp(path.join(tmpdir(), 'probe3-symlink-'))
const outside = await mkdtemp(path.join(tmpdir(), 'probe3-outside-'))
let server
try {
  const manager = await harness.app.app.deps.sites.load()
  const build = async () => {
    const lease = await manager.acquire('alpha', 'build')
    try { return await lease.env.run(BuildEntry, { build: { outputDir } }, async ({ builder }) => (await builder.load()).build()) }
    finally { lease.release() }
  }
  await build()
  await writeFile(path.join(outside, 'index.html'), 'OUTSIDE\n')
  await writeFile(path.join(outside, 'secret.txt'), 'SECRET\n')
  await rm(path.join(outputDir, 'posts', 'shared-slug'), { recursive: true })
  await symlink(outside, path.join(outputDir, 'posts', 'shared-slug'))
  const second = await build().then(() => 'built', error => error.code ?? error.message)
  check('a build over a symlinked page directory is refused', second === 'UNSAFE_OUTPUT_DIR', second)
  check('the file behind the link is untouched', (await readFile(path.join(outside, 'index.html'), 'utf8')) === 'OUTSIDE\n')
  await symlink(path.join(outside, 'secret.txt'), path.join(outputDir, 'leak.txt'))
  server = await startStaticServer(outputDir)
  const leak = await fetchText(`${server.url}/leak.txt`)
  const dir = await fetchText(`${server.url}/posts/shared-slug/`)
  const legit = await fetchText(`${server.url}/posts/hello-world/`)
  check('the static server serves nothing behind a link', leak.status === 404 && dir.status === 404 && !/SECRET|OUTSIDE/.test(leak.body + dir.body), { leak: leak.status, dir: dir.status })
  check('the rest of the build is still served', legit.status === 200, legit.status)
}
finally {
  await server?.close()
  await harness.close()
  await rm(outputDir, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
}
process.exitCode = failed === 0 ? 0 : 1

// F-AP3-06 (minor/docs): `readPreviousBuild()` accepts any JSON object with a `files` array as "a previous build
// of this builder" — `builder`, `tenantId`, `configRevision`, `contentVersion` (all written by the builder) are
// never checked, although StaticBuildErrorCode documents BAD_MANIFEST as "the on-disk build manifest is not one
// this builder wrote". A manifest written by something else (or a hand-made one) turns a foreign directory
// into "a previous build" and makes the next build DELETE files listed in it that the builder never wrote —
// the guarantee of F-AP-08 ("never deletes files it did not write") rests on a file nobody verifies.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BUILD_MANIFEST_FILE, BuildEntry } from '../../../../apps/hyla-mini/dist/index.js'
import { createFilesystemApp } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }

const harness = await createFilesystemApp()
const outputDir = await mkdtemp(path.join(tmpdir(), 'audit3-manifest-'))
try {
  const manager = await harness.app.app.deps.sites.load()
  const build = async () => {
    const lease = await manager.acquire('alpha', 'build')
    try { return await lease.env.run(BuildEntry, { build: { outputDir } }, async ({ builder }) => (await builder.load()).build()) }
    finally { lease.release() }
  }
  await writeFile(path.join(outputDir, 'precious.txt'), 'not written by hyla\n')
  await writeFile(path.join(outputDir, 'notes.md'), 'foreign\n')
  const refused = await build().then(() => 'built', error => error.code ?? error.message)
  check('control: a foreign non-empty directory without a manifest is refused', refused === 'OUTPUT_DIR_NOT_EMPTY', refused)

  // A manifest nobody from Hyla wrote: no `builder`, no tenant, no versions — just a file list.
  await writeFile(path.join(outputDir, BUILD_MANIFEST_FILE), JSON.stringify({ generator: 'some-other-tool', files: ['precious.txt'] }))
  const outcome = await build().then(() => 'built', error => error.code ?? error.message)
  check('a manifest that this builder did not write is refused as BAD_MANIFEST (documented meaning of the code)', outcome === 'BAD_MANIFEST', outcome)
  const precious = await readFile(path.join(outputDir, 'precious.txt'), 'utf8').then(() => 'present', () => 'DELETED')
  const notes = await readFile(path.join(outputDir, 'notes.md'), 'utf8').then(() => 'present', () => 'DELETED')
  check('precious.txt (never written by the builder) still exists after the build', precious === 'present', { precious, notes })
}
finally {
  await harness.close()
  await rm(outputDir, { recursive: true, force: true })
}
process.exitCode = failed === 0 ? 0 : 1

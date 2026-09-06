// syna-v05-compat: this file exercises the deprecated 0.5 forms on purpose, next to their 0.6 replacements (aliases removed in 0.7.0).
// R4 (v0.6): the loadable dependency ref is `ServiceRef<T>`; `DependencyRef<T>` becomes the deprecated union
// `ServiceRef<T> | InputRef<T>` (removed in 0.7.0). Reason 3: `InputRef` already existed, `DependencyRef` was the
// asymmetric name of the other kind. A type-only rename: this test pins the compiled declarations and that the
// ref objects handed out are unchanged.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRuntime, definePackage, loadAll } from '../dist/index.js'

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')

test('R4 the compiled declarations export ServiceRef and the deprecated union alias DependencyRef', () => {
  const declarations = readFileSync(path.join(dist, 'descriptors.d.ts'), 'utf8')
  assert.match(declarations, /export interface ServiceRef<T> \{\s*load\(options\?: LoadOptions\): Promise<T>;/)
  assert.match(declarations, /@deprecated Use `ServiceRef` for the loadable ref\.[\s\S]{0,300}Removed in 0\.7\.0\.[\s\S]{0,40}export type DependencyRef<T> = ServiceRef<T> \| InputRef<T>;/)
  assert.match(declarations, /: ServiceRef<DependencyOutput<D>>;/, 'DependencyRefFor maps Service-like dependencies to ServiceRef')
  const loading = readFileSync(path.join(dist, 'loading.d.ts'), 'utf8')
  assert.match(loading, /Refs extends Readonly<Record<string, ServiceRef<unknown>>>/, 'loadAll is constrained to ServiceRef')
})

test('R4 refs are unchanged objects: a Service ref loads, an Input ref reads, loadAll batches Service refs', async () => {
  const define = definePackage({ name: '@v06/r4', version: '1.0.0', syna: { id: 'r4' } })
  const Tenant = define.input('tenant')
  const Db = define.service('db', { setup: () => ({ db: true }) })
  const Cache = define.service('cache', { requires: { db: Db }, setup: () => ({ cache: true }) })
  const Root = define.entry('root', { requires: { db: Db, cache: Cache, tenant: Tenant }, parameters: { tenant: Tenant } })
  const runtime = createRuntime({ services: [Db, Cache] })
  const env = await runtime.enter(Root, { tenant: 't1' })
  const { db, cache, tenant } = env.deps
  assert.equal(typeof db.load, 'function')
  assert.equal(typeof tenant.read, 'function')
  assert.equal('then' in db, false, 'a ref is never thenable')
  assert.strictEqual(await Promise.resolve(db), db)
  assert.equal(tenant.read(), 't1')
  const loaded = await loadAll({ db, cache })
  assert.deepEqual(Object.keys(loaded).sort(), ['cache', 'db'])
  assert.strictEqual(loaded.db, await db.load())
  await runtime.dispose()
})

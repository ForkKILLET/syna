// R3 (v0.6): the Runtime type is `Runtime`; `SynaRuntime` is its deprecated alias (removed in 0.7.0). A type-only
// rename has no runtime path of its own, so this test pins what the compiled declarations promise and that the
// object `createRuntime()` returns is one and the same under either name.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRuntime, definePackage } from '../dist/index.js'

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
const declarations = readFileSync(path.join(dist, 'descriptors.d.ts'), 'utf8')

test('R3 the compiled declarations export `Runtime` and the deprecated alias `SynaRuntime = Runtime`', () => {
  assert.match(declarations, /export interface Runtime \{/)
  assert.match(declarations, /@deprecated Use `Runtime`\. Removed in 0\.7\.0\.[\s\S]{0,40}export type SynaRuntime = Runtime;/)
  assert.match(readFileSync(path.join(dist, 'runtime.d.ts'), 'utf8'), /export declare function createRuntime\(options: CreateRuntimeOptions\): Runtime;/)
})

test('R3 createRuntime() returns the documented Runtime surface', async () => {
  const define = definePackage({ name: '@v06/r3', version: '1.0.0', syna: { id: 'r3' } })
  const Db = define.service('db', { setup: () => ({}) })
  const runtime = createRuntime({ services: [Db] })
  assert.deepEqual(Object.keys(runtime.catalog).sort(), ['implementations', 'resolve', 'revisions'])
  for (const method of ['enter', 'run', 'check', 'explain', 'inspect', 'dispose']) assert.equal(typeof runtime[method], 'function', method)
  assert.equal(typeof runtime[Symbol.asyncDispose], 'function')
  assert.deepEqual(runtime.inspect().admittedServices, [Db.key])
  await runtime.dispose()
})

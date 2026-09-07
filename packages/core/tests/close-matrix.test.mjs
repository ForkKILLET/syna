// The close matrix required by SYNA_RC3_EXECUTION_PROMPT.md §3: what is stuck or
// throwing (a Ready slot's cleanup hanging or throwing, the rollback of an attempt
// that settled inside the grace, the late cleanup of an abandoned attempt) against
// what became of the waiter (none, still waiting, cancelled, timed out) — plus the
// two properties of concurrent destruction: every dependency chain keeps its order,
// and one level of the close costs one grace per slot of the longest chain.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage } from '../dist/index.js'

const makeDefine = id => definePackage({ name: `@rc3/${id.replaceAll('.', '-')}`, version: '1.0.0', syna: { id } })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const stateOf = (env, name) => env.inspect().nodes.find(node => node.label.includes(`/${name}@`))?.state

/** A chain `<prefix>1 → <prefix>2 → <prefix>3`, each cleanup recording itself. */
const chain = (define, prefix, cleanup) => {
  const tail = define.service(`${prefix}3`, {
    setup(_deps, lifecycle) { lifecycle.onDispose(() => cleanup(`${prefix}3`)); return { name: `${prefix}3` } },
  })
  const middle = define.service(`${prefix}2`, {
    requires: { next: tail },
    async setup({ next }, lifecycle) { await next.load(); lifecycle.onDispose(() => cleanup(`${prefix}2`)); return { name: `${prefix}2` } },
  })
  const head = define.service(`${prefix}1`, {
    requires: { next: middle },
    async setup({ next }, lifecycle) { await next.load(); lifecycle.onDispose(() => cleanup(`${prefix}1`)); return { name: `${prefix}1` } },
  })
  return { head, middle, tail, all: [head, middle, tail] }
}

test('concurrent destruction: three independent chains are disposed at once while each chain keeps its own order', async () => {
  const define = makeDefine('rc3.matrix.chains')
  const order = []
  const slow = async name => { order.push(`${name}:start`); await sleep(40); order.push(`${name}:end`) }
  const a = chain(define, 'a', slow)
  const b = chain(define, 'b', slow)
  const c = chain(define, 'c', slow)
  const services = [...a.all, ...b.all, ...c.all]
  const Entry = define.entry({ requires: { a: a.head, b: b.head, c: c.head } })
  const runtime = createRuntime({ services, limits: { disposalGraceMs: 1_000 } })
  const env = await runtime.enter(Entry)
  await Promise.all([env.deps.a.load(), env.deps.b.load(), env.deps.c.load()])

  const started = Date.now()
  await env.dispose()
  const elapsed = Date.now() - started
  // Nine cleanups of 40 ms: 360 ms in a row, three chains of three concurrently ≈ 120 ms.
  assert.ok(elapsed < 260, `independent chains are disposed concurrently (took ${elapsed} ms)`)

  const ends = order.filter(entry => entry.endsWith(':end')).map(entry => entry.slice(0, -4))
  for (const prefix of ['a', 'b', 'c']) {
    assert.deepEqual(ends.filter(name => name.startsWith(prefix)), [`${prefix}1`, `${prefix}2`, `${prefix}3`],
      `chain ${prefix} is disposed dependant-first, one slot at a time`)
  }
  assert.deepEqual(new Set(order.slice(0, 3)), new Set(['a1:start', 'b1:start', 'c1:start']),
    'the three heads start together: the chains interleave')
  assert.equal(order.length, 18)
  await runtime.dispose()
})

test('the cleanup step of one Env costs one grace per slot of its longest chain, not one per slot', async () => {
  const define = makeDefine('rc3.matrix.bound')
  const graceMs = 40
  const hang = () => new Promise(() => undefined)

  // Five independent slots, every cleanup hung: one budget for the whole level.
  const wide = Array.from({ length: 5 }, (_unused, index) => define.service(`wide${index}`, {
    setup(_deps, { onDispose }) { onDispose(hang); return { index } },
  }))
  const WideEntry = define.entry('wide', { requires: Object.fromEntries(wide.map((service, index) => [`w${index}`, service])) })
  const runtimeWide = createRuntime({ services: wide, limits: { disposalGraceMs: graceMs } })
  const wideEnv = await runtimeWide.enter(WideEntry)
  await Promise.all(wide.map((_service, index) => wideEnv.deps[`w${index}`].load()))
  const wideStarted = Date.now()
  await wideEnv.dispose()
  const wideElapsed = Date.now() - wideStarted
  assert.ok(wideElapsed >= graceMs && wideElapsed < graceMs * 3,
    `five independent hung cleanups cost one budget (took ${wideElapsed} ms, budget ${graceMs} ms)`)
  assert.equal(wideEnv.state, 'disposed')
  assert.equal(runtimeWide.inspect().unsettledAttempts.length, 5)

  // A chain of three, every cleanup hung: three budgets, and never more.
  const deep = chain(define, 'deep', () => hang())
  const DeepEntry = define.entry('deep', { requires: { head: deep.head } })
  const runtimeDeep = createRuntime({ services: deep.all, limits: { disposalGraceMs: graceMs } })
  const deepEnv = await runtimeDeep.enter(DeepEntry)
  await deepEnv.deps.head.load()
  const deepStarted = Date.now()
  await deepEnv.dispose()
  const deepElapsed = Date.now() - deepStarted
  assert.ok(deepElapsed >= graceMs * 3 && deepElapsed < graceMs * 3 + 220,
    `a chain of three hung cleanups costs three budgets (took ${deepElapsed} ms, budget ${graceMs} ms)`)
  assert.equal(deepEnv.state, 'disposed')
  assert.deepEqual(
    ['deep1', 'deep2', 'deep3'].map(name => stateOf(deepEnv, name)),
    ['abandoned', 'abandoned', 'abandoned'],
    'every slot of the chain was reached, dependant-first, and each one abandoned on its own budget',
  )
  assert.equal(runtimeDeep.inspect().unsettledAttempts.length, 3)
})

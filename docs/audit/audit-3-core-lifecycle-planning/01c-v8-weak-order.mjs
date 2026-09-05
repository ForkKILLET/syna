// Mechanism check (pure V8, no Syna): a FinalizationRegistry target T whose only strong path to a
// token K goes through T's own closures, with a WeakRef to K kept in a "ledger". When T dies, is K
// still dereferenceable inside the cleanup callback? Two shapes: an immediate full GC after the
// drop, and young-generation churn (allocations) before the GC, which is what entering another Env
// does in the Syna regression test. Run with --expose-gc (this file spawns itself).
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
if (process.argv[2] !== 'child') {
  for (const shape of ['immediate-gc', 'churn-then-gc', 'yield-then-gc']) {
    const outcomes = []
    for (let i = 0; i < 5; i += 1) {
      const { stdout } = await run(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), 'child', shape])
      outcomes.push(JSON.parse(stdout.trim()))
    }
    console.log(`${shape}: ${JSON.stringify(outcomes)}`)
  }
}
else {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const shape = process.argv[3]
  const ledger = new Map()
  const results = []
  const registry = new FinalizationRegistry(id => {
    const record = ledger.get(id)
    results.push({ id, tokenAlive: record?.token.deref() !== undefined })
  })
  const make = id => {
    const token = { id, cleanups: [() => undefined] }
    const target = { reaction: () => token }      // the only strong path to the token goes through the target
    ledger.set(id, { token: new WeakRef(token) })
    registry.register(target, id, token)
    return target
  }
  let t = make(1)
  t = undefined
  if (shape === 'yield-then-gc') await sleep(0)   // a job boundary: the WeakRef's KeepDuringJob pin of the token is released
  if (shape === 'churn-then-gc') {
    let junk = []
    for (let i = 0; i < 200_000; i += 1) junk.push({ i, s: 'x'.repeat(8) })   // young-generation churn -> scavenges
    junk = undefined
  }
  for (let round = 0; round < 10; round += 1) { globalThis.gc(); await sleep(10) }
  await sleep(50)
  console.log(JSON.stringify({ callbacks: results }))
}

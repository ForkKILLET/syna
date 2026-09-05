// Probe harness for the third independent audit (core lifecycle / planning line).
// PASS/FAIL lines, deferreds, a watchdog so a probe never hangs, exit 1 on any FAIL.
import { definePackage } from '../../../../packages/core/dist/index.js'

const results = []
let watchdog

export function startWatchdog(ms = 10_000) {
  watchdog = setTimeout(() => {
    console.log(`FAIL  [watchdog] probe did not finish within ${ms} ms`)
    summary()
    process.exit(2)
  }, ms)
}

export function check(name, condition, observed) {
  const ok = Boolean(condition)
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${observed !== undefined ? `  -- observed: ${fmt(observed)}` : ''}`)
  return ok
}

export function note(name, observed) {
  console.log(`NOTE  ${name}${observed !== undefined ? `  -- observed: ${fmt(observed)}` : ''}`)
}

export function fmt(value) {
  if (value instanceof AggregateError) {
    return `AggregateError(${JSON.stringify(value.message)}, errors=[${value.errors.map(fmt).join(', ')}])`
  }
  if (value instanceof Error) {
    const code = value.code ? `${value.code}: ` : ''
    const cause = value.cause ? ` cause=${fmt(value.cause)}` : ''
    return `${value.name}(${code}${JSON.stringify(value.message)})${cause}`
  }
  if (typeof value === 'string') return JSON.stringify(value)
  try { return JSON.stringify(value) } catch { return String(value) }
}

export function summary() {
  const failed = results.filter(result => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map(f => f.name).join(' | ')}` : ''}`)
  clearTimeout(watchdog)
  return failed.length
}

export const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export const tick = () => new Promise(resolve => setImmediate(resolve))
export const waitFor = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met')
    await sleep(2)
  }
}
export const settle = promise => promise.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }))

export const makeDefine = (id, version = '1.0.0') => definePackage({
  name: `@audit3/${id.replaceAll('.', '-')}`,
  version,
  syna: { id },
})

export function trackUnhandled() {
  const unhandled = []
  process.on('unhandledRejection', reason => unhandled.push(reason))
  return unhandled
}

export async function main(fn, watchdogMs) {
  startWatchdog(watchdogMs)
  try { await fn() }
  catch (error) { check('probe body threw', false, error) }
  const failed = summary()
  await new Promise(resolve => setTimeout(resolve, 30))
  process.exit(failed ? 1 : 0)
}

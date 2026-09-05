// Regressions for the gate's step runner (scripts/lib/step-runner.mjs), I-111: a step's timeout must
// end the whole process tree the step started, and nothing outside the gate's control may hold it.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createStepRunner, parseTap } from '../lib/step-runner.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const logsDir = mkdtempSync(path.join(tmpdir(), 'syna-step-runner-'))
after(() => rmSync(logsDir, { recursive: true, force: true }))
const recorded = []
const runner = createStepRunner({ root, logsDir, onStep: step => recorded.push(step) })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const pidFileFor = name => path.join(logsDir, `${name}.pid`)
const readPid = name => Number(readFileSync(pidFileFor(name), 'utf8'))
const waitFor = async (predicate, what, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}
const waitForPid = name => waitFor(() => existsSync(pidFileFor(name)), `${name}'s pid file`)

// The grandchild writes its pid and waits to be signalled; `ignoreTerm` makes it survive SIGTERM.
const grandchild = ignoreTerm => `require('node:fs').writeFileSync(process.env.PIDFILE, String(process.pid)); ${ignoreTerm ? "process.on('SIGTERM', () => {}); " : ''}setInterval(() => {}, 1000)`
// A wrapper that keeps a child holding its stdio (the shape of `pg-test-cluster.mjs with`).
const wrapper = (ignoreTerm, detachedChild = false) => `
  const { spawn } = require('node:child_process')
  ${ignoreTerm ? "process.on('SIGTERM', () => {})" : ''}
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild(ignoreTerm))}], { stdio: 'inherit', detached: ${detachedChild} })
  ${detachedChild ? 'child.unref(); child.on("spawn", () => setTimeout(() => process.exit(0), 200))' : "child.on('exit', () => process.exit(0)); setInterval(() => {}, 1000)"}
`

test('parseTap reads the reporter summary and returns undefined without one', () => {
  assert.equal(parseTap('hello\n'), undefined)
  assert.deepEqual(parseTap('# tests 4\n# pass 3\n# fail 1\n# skipped 0\n# todo 0\n# cancelled 0\n'), { tests: 4, pass: 3, fail: 1, skipped: 0, todo: 0, cancelled: 0 })
})

test('a step that exits 0 is ok, its TAP counts are parsed and its output is logged', async () => {
  const step = await runner.run('tap-ok', process.execPath, ['-e', "console.log('# tests 2\\n# pass 2\\n# fail 0')"])
  assert.equal(step.ok, true)
  assert.equal(step.exitCode, 0)
  assert.deepEqual(step.tests, { tests: 2, pass: 2, fail: 0, skipped: 0, todo: 0, cancelled: 0 })
  assert.match(readFileSync(path.join(root, step.log), 'utf8'), /# pass 2/)
  // The gate records steps through onStep: the very object run() resolves with, so the manifest cannot miss a step.
  assert.equal(recorded.at(-1), step)
})

test('expectStdout turns an exit-0 step without the expected lines into a failed step', async () => {
  const step = await runner.run('expect-stdout', process.execPath, ['-e', "console.log('hello')"], { expectStdout: output => /^demo: OK$/m.test(output) })
  assert.equal(step.exitCode, 0)
  assert.equal(step.ok, false)
  assert.match(step.note, /expectStdout/)
})

test('a command that cannot be spawned is a failed step, not a crash', async () => {
  const step = await runner.run('spawn-error', path.join(logsDir, 'no-such-binary'), [])
  assert.equal(step.ok, false)
  assert.match(step.spawnError, /ENOENT/)
})

test('the timeout ends the whole process group: a wrapper whose child holds the pipes cannot outlive the step (I-111)', async () => {
  const name = 'group-timeout'
  const started = Date.now()
  const step = await runner.run(name, process.execPath, ['-e', wrapper(false)], { timeoutMs: 500, killGraceMs: 3_000, env: { PIDFILE: pidFileFor(name) } })
  const elapsed = Date.now() - started
  assert.equal(step.timedOut, true)
  assert.equal(step.ok, false)
  assert.equal(step.signal, 'SIGTERM')
  assert.ok(elapsed < 4_000, `the step ended ${elapsed} ms after it started`)
  const pid = readPid(name)
  await waitFor(() => !alive(pid), 'the grandchild to end', 2_000)
  assert.equal(alive(pid), false)
  assert.match(step.note, /timed out after 500 ms/)
})

test('a group that ignores SIGTERM is killed after killGraceMs', async () => {
  const name = 'group-kill'
  const started = Date.now()
  const step = await runner.run(name, process.execPath, ['-e', wrapper(true)], { timeoutMs: 300, killGraceMs: 500, env: { PIDFILE: pidFileFor(name) } })
  const elapsed = Date.now() - started
  assert.equal(step.timedOut, true)
  assert.equal(step.signal, 'SIGKILL')
  assert.ok(elapsed < 4_000, `the step ended ${elapsed} ms after it started`)
  const pid = readPid(name)
  await waitFor(() => !alive(pid), 'the grandchild to end', 2_000)
  assert.equal(alive(pid), false)
})

test('a process outside the group that keeps the pipes open cannot hold the gate past closeWaitMs; the step is reported as not ok', async () => {
  const name = 'close-wait'
  let pid
  try {
    const started = Date.now()
    const step = await runner.run(name, process.execPath, ['-e', wrapper(false, true)], { closeWaitMs: 500, env: { PIDFILE: pidFileFor(name) } })
    const elapsed = Date.now() - started
    await waitForPid(name)
    pid = readPid(name)
    assert.equal(alive(pid), true, 'the detached grandchild is the pipe holder and is still alive')
    assert.equal(step.exitCode, 0)
    assert.equal(step.closeTimedOut, true)
    assert.equal(step.ok, false)
    assert.match(step.note, /stdio not released within 500 ms/)
    assert.ok(elapsed < 4_000, `the step ended ${elapsed} ms after it started`)
  }
  finally {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
  }
})

test('abort() ends every running step and resolves once they have closed', async () => {
  const pending = runner.run('abort-me', process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  await sleep(300)
  assert.equal(runner.active.size, 1)
  const left = await runner.abort('SIGTERM', 5_000)
  const step = await pending
  assert.equal(left, 0)
  assert.equal(step.signal, 'SIGTERM')
  assert.equal(step.timedOut, undefined)
  assert.equal(step.ok, false)
})

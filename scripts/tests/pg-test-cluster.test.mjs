// Regressions for `scripts/pg-test-cluster.mjs with` (I-111, I-115): a signal to the wrapper reaches
// the command it started and the temporary cluster is stopped; the server the command ran against
// is printed so the gate can record it.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const script = path.join(root, 'scripts', 'pg-test-cluster.mjs')
const scratch = mkdtempSync(path.join(tmpdir(), 'syna-cluster-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const waitFor = async (predicate, what, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

// The command the wrapper runs: records its pid, then waits to be signalled.
const program = "require('node:fs').writeFileSync(process.env.PIDFILE, String(process.pid)); setInterval(() => {}, 1000)"

function startWrapper(name, env) {
  const pidFile = path.join(scratch, `${name}.pid`)
  const wrapper = spawn(process.execPath, [script, 'with', '--', process.execPath, '-e', program], {
    cwd: root,
    env: { ...process.env, PIDFILE: pidFile, ...env },
    stdio: ['ignore', 'pipe', 'pipe'], // the shape the gate uses: the command inherits these pipes
  })
  const chunks = []
  wrapper.stdout.on('data', chunk => chunks.push(chunk))
  wrapper.stderr.on('data', chunk => chunks.push(chunk))
  const state = { exit: undefined, closed: false }
  wrapper.on('exit', (code, signal) => { state.exit = { code, signal } })
  wrapper.on('close', () => { state.closed = true })
  return {
    wrapper,
    state,
    output: () => Buffer.concat(chunks).toString('utf8'),
    pid: async () => {
      await waitFor(() => existsSync(pidFile), 'the command to start', 60_000)
      return Number(readFileSync(pidFile, 'utf8'))
    },
  }
}

function findPgCtl() {
  const candidates = [
    process.env.SYNA_PG_BIN ? path.join(process.env.SYNA_PG_BIN, 'pg_ctl') : undefined,
    '/opt/homebrew/opt/postgresql@17/bin/pg_ctl',
    '/opt/homebrew/opt/postgresql@16/bin/pg_ctl',
    '/usr/lib/postgresql/17/bin/pg_ctl',
    '/usr/lib/postgresql/16/bin/pg_ctl',
    'pg_ctl',
  ].filter(Boolean)
  return candidates.find(candidate => spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0)
}

test('with an external SYNA_TEST_PG_URL: SIGTERM to the wrapper ends the command, the wrapper exits 143 and releases its pipes', async () => {
  const url = 'postgres://nobody@127.0.0.1:1/none'
  const run = startWrapper('external', { SYNA_TEST_PG_URL: url })
  let pid
  try {
    pid = await run.pid()
    assert.equal(alive(pid), true)
    run.wrapper.kill('SIGTERM')
    await waitFor(() => run.state.closed, "the wrapper's close event", 10_000)
    assert.equal(alive(pid), false, 'the command was ended by the forwarded signal')
    assert.deepEqual(run.state.exit, { code: 143, signal: null })
    assert.match(run.output(), new RegExp(`^pg-test-cluster: server external at ${url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\(SYNA_TEST_PG_URL, not managed here\\)$`, 'm'))
  }
  finally {
    // A wrapper that did not forward the signal leaves the command holding this process's pipes.
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
  }
})

test('with a temporary cluster: SIGTERM to the wrapper ends the command, stops and removes the cluster, and the server line names the version', async () => {
  const pgCtl = findPgCtl()
  assert.ok(pgCtl, 'PostgreSQL binaries (pg_ctl) must be available: install postgresql@17 or set SYNA_PG_BIN')
  // Unix socket paths are short-limited: the cluster directory must be a short path.
  const base = tmpdir().length <= 40 ? tmpdir() : '/tmp'
  const clusterDir = path.join(base, `syna-sig-${process.pid}`)
  rmSync(clusterDir, { recursive: true, force: true })
  const clusterRunning = () => spawnSync(pgCtl, ['-D', path.join(clusterDir, 'data'), 'status'], { encoding: 'utf8' }).status === 0
  const run = startWrapper('managed', { SYNA_TEST_PG_URL: '', SYNA_PG_CLUSTER_DIR: clusterDir, SYNA_PG_PORT: '54500' })
  let pid
  try {
    pid = await run.pid()
    assert.equal(clusterRunning(), true, 'the cluster is running while the command runs')
    run.wrapper.kill('SIGTERM')
    await waitFor(() => run.state.closed, "the wrapper's close event", 20_000)
    assert.equal(alive(pid), false, 'the command was ended by the forwarded signal')
    assert.equal(clusterRunning(), false, 'the cluster was stopped')
    assert.equal(existsSync(clusterDir), false, 'the cluster directory was removed')
    assert.deepEqual(run.state.exit, { code: 143, signal: null })
    assert.match(run.output(), /^pg-test-cluster: server PostgreSQL \d+(\.\d+)* at postgres:\/\/syna@127\.0\.0\.1:\d+\/postgres \(temporary cluster\)$/m)
  }
  finally {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
    if (clusterRunning()) spawnSync(pgCtl, ['-D', path.join(clusterDir, 'data'), '-w', '-m', 'fast', 'stop'])
    rmSync(clusterDir, { recursive: true, force: true })
  }
})

// p7 — scripts/pg-test-cluster.mjs `with` has no SIGTERM handler, so the gate's timeout policy
// (scripts/verify-v05.mjs:48-55, "ask politely first so wrappers (the PostgreSQL cluster script)
// can stop what they started, then kill") does not do what the comment says: SIGTERM kills only
// the wrapper; the test process it spawned (stdio inherited) and the temporary PostgreSQL cluster
// keep running, and because the grandchild still holds the wrapper's stdout/stderr pipes the
// 'close' event verify-v05 waits for does not fire until the grandchild exits on its own — the
// step's timeout cannot end the step. The follow-up SIGKILL (15 s later) targets the already-dead
// wrapper.
//
// This probe manages its own cluster under /tmp/syna-audit3-sig (created and removed here).
// Run: node <this file>
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const script = path.join(root, 'scripts', 'pg-test-cluster.mjs')
const clusterDir = '/tmp/syna-audit3-sig'
const pgCtl = ['/opt/homebrew/opt/postgresql@17/bin/pg_ctl', '/opt/homebrew/opt/postgresql@16/bin/pg_ctl', '/usr/lib/postgresql/17/bin/pg_ctl', '/usr/lib/postgresql/16/bin/pg_ctl', 'pg_ctl']
  .find(candidate => spawnSync(candidate, ['--version']).status === 0)
if (!pgCtl) { console.log('SKIP p7: pg_ctl not found'); process.exit(2) }
const clusterRunning = () => spawnSync(pgCtl, ['-D', path.join(clusterDir, 'data'), 'status']).status === 0
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

rmSync(clusterDir, { recursive: true, force: true })
const pidFile = path.join(tmpdir(), `syna-audit3-p7-${process.pid}.pid`)
rmSync(pidFile, { force: true })
const grandchildProgram = "require('node:fs').writeFileSync(process.env.PIDFILE, String(process.pid)); setInterval(() => {}, 1000)"
// Spawned the way verify-v05.mjs spawns its steps: stdout/stderr piped, the wrapper inherits them to its child.
const wrapper = spawn(process.execPath, [script, 'with', '--', process.execPath, '-e', grandchildProgram], {
  cwd: root,
  env: { ...process.env, SYNA_PG_CLUSTER_DIR: clusterDir, PIDFILE: pidFile, SYNA_TEST_PG_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const output = []
wrapper.stdout.on('data', chunk => output.push(chunk))
wrapper.stderr.on('data', chunk => output.push(chunk))
let exited
let closed = false
wrapper.on('exit', (code, signal) => { exited = { code, signal } })
wrapper.on('close', () => { closed = true })

let grandchildPid
try {
  for (let waited = 0; waited < 60_000 && !existsSync(pidFile); waited += 200) await sleep(200)
  if (!existsSync(pidFile)) throw new Error(`the wrapper did not start its child within 60 s: ${Buffer.concat(output)}`)
  grandchildPid = Number(readFileSync(pidFile, 'utf8'))
  check('setup: the cluster is running and the test child is alive before SIGTERM', clusterRunning() && alive(grandchildPid), { grandchildPid })

  wrapper.kill('SIGTERM')
  for (let waited = 0; waited < 5000 && exited === undefined; waited += 100) await sleep(100)
  await sleep(500)
  console.log(`wrapper after SIGTERM: exit ${JSON.stringify(exited)}; close fired: ${closed}; grandchild alive: ${alive(grandchildPid)}; cluster running: ${clusterRunning()}`)
  check('SIGTERM to the wrapper ends the test process it started', !alive(grandchildPid), { grandchildPid })
  check('SIGTERM to the wrapper stops the temporary cluster it started', !clusterRunning(), { clusterDir })
  await sleep(2000)
  check("the wrapper's 'close' event (what verify-v05 awaits) fires after SIGTERM while the grandchild lives", closed, { closed, exited })
}
finally {
  if (grandchildPid && alive(grandchildPid)) process.kill(grandchildPid, 'SIGKILL')
  for (let waited = 0; waited < 5000 && !closed; waited += 100) await sleep(100)
  console.log(`after killing the grandchild: close fired: ${closed}`)
  if (clusterRunning()) spawnSync(pgCtl, ['-D', path.join(clusterDir, 'data'), '-w', '-m', 'fast', 'stop'])
  rmSync(clusterDir, { recursive: true, force: true })
  rmSync(pidFile, { force: true })
  console.log(`cleanup: cluster running: ${clusterRunning()}; ${clusterDir} exists: ${existsSync(clusterDir)}`)
}
process.exitCode = failed === 0 ? 0 : 1

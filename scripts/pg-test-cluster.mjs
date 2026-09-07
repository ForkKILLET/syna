#!/usr/bin/env node
// Temporary PostgreSQL test cluster for the Syna / multitenant-blog integration tests.
//
//   node scripts/pg-test-cluster.mjs start   → initdb (if needed) + start; prints SYNA_TEST_PG_URL
//   node scripts/pg-test-cluster.mjs stop    → stop and remove the cluster data
//   node scripts/pg-test-cluster.mjs status
//   node scripts/pg-test-cluster.mjs with -- <command...> → start, run command with SYNA_TEST_PG_URL, stop
//
// If SYNA_TEST_PG_URL is already set, `with` runs the command against it and does not manage a cluster.
// The cluster lives under work/pg (short path: unix socket paths are limited to ~100 chars) and is
// always created by this script; the user's own PostgreSQL server on 5432 is never touched.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { constants } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clusterDir = process.env.SYNA_PG_CLUSTER_DIR ?? path.join(root, 'work', 'pg')
const dataDir = path.join(clusterDir, 'data')
const logFile = path.join(clusterDir, 'server.log')
const user = 'syna'
const preferredPort = Number(process.env.SYNA_PG_PORT ?? 54329)

function findBinary(name) {
  const candidates = [
    process.env.SYNA_PG_BIN ? path.join(process.env.SYNA_PG_BIN, name) : undefined,
    `/opt/homebrew/opt/postgresql@17/bin/${name}`,
    `/opt/homebrew/opt/postgresql@16/bin/${name}`,
    `/usr/lib/postgresql/17/bin/${name}`,
    `/usr/lib/postgresql/16/bin/${name}`,
    name,
  ].filter(Boolean)
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return undefined
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

async function freePort(start) {
  for (let port = start; port < start + 50; port += 1) {
    const ok = await new Promise(resolve => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (ok) return port
  }
  throw new Error(`No free TCP port found from ${start}.`)
}

function readPort() {
  const pidFile = path.join(dataDir, 'postmaster.pid')
  if (!existsSync(pidFile)) return undefined
  const lines = readFileSync(pidFile, 'utf8').split('\n')
  return Number(lines[3])
}

function isRunning(pgCtl) {
  if (!existsSync(dataDir)) return false
  return spawnSync(pgCtl, ['-D', dataDir, 'status'], { encoding: 'utf8' }).status === 0
}

function url(port, database = 'postgres') {
  return `postgres://${user}@127.0.0.1:${port}/${database}`
}

async function start() {
  const initdb = findBinary('initdb')
  const pgCtl = findBinary('pg_ctl')
  if (!initdb || !pgCtl) {
    throw new Error('PostgreSQL binaries (initdb, pg_ctl) not found. Install postgresql@17 or set SYNA_PG_BIN / SYNA_TEST_PG_URL.')
  }
  if (clusterDir.length > 80) {
    throw new Error(`Cluster path too long for unix sockets: ${clusterDir}. Set SYNA_PG_CLUSTER_DIR to a short path.`)
  }
  mkdirSync(clusterDir, { recursive: true })
  if (isRunning(pgCtl)) {
    const port = readPort()
    console.log(`already running: ${url(port)}`)
    return url(port)
  }
  if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
    run(initdb, ['-D', dataDir, '-U', user, '--auth=trust', '--no-locale', '-E', 'UTF8'])
  }
  const port = await freePort(preferredPort)
  run(pgCtl, [
    '-D', dataDir,
    '-o', `-p ${port} -k ${clusterDir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
    '-l', logFile,
    '-w', 'start',
  ])
  console.log(`started: ${url(port)}`)
  return url(port)
}

function stop() {
  const pgCtl = findBinary('pg_ctl')
  if (pgCtl && isRunning(pgCtl)) {
    run(pgCtl, ['-D', dataDir, '-w', '-m', 'fast', 'stop'])
    console.log('stopped')
  }
  if (existsSync(clusterDir)) {
    rmSync(clusterDir, { recursive: true, force: true })
    console.log(`removed ${clusterDir}`)
  }
}

function status() {
  const pgCtl = findBinary('pg_ctl')
  if (pgCtl && isRunning(pgCtl)) {
    console.log(`running: ${url(readPort())}`)
    return 0
  }
  console.log('not running')
  return 1
}

/** The version of the server binaries the cluster runs on (`postgres --version` → "PostgreSQL 17.10"). */
function serverVersion() {
  const binary = findBinary('postgres') ?? findBinary('pg_ctl')
  if (!binary) return 'unknown'
  const output = spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim()
  const match = output.match(/\(PostgreSQL\)\s+(\S+)/)
  return match ? `PostgreSQL ${match[1]}` : output
}

async function withCommand(argv) {
  const separator = argv.indexOf('--')
  const command = separator >= 0 ? argv.slice(separator + 1) : argv
  if (command.length === 0) throw new Error('with: missing command after --')
  let managed = false
  let connection = process.env.SYNA_TEST_PG_URL
  if (!connection) {
    connection = await start()
    managed = true
  }
  // Recorded by the gate's manifest: which server the command really ran against (I-115).
  console.log(`pg-test-cluster: server ${managed ? serverVersion() : 'external'} at ${connection} (${managed ? 'temporary cluster' : 'SYNA_TEST_PG_URL, not managed here'})`)
  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, SYNA_TEST_PG_URL: connection },
  })
  // A signal to this wrapper is forwarded to the command; the cluster is stopped once the command
  // has ended, whatever ended it (I-111). Before, SIGTERM ended the wrapper alone and left both the
  // command and the temporary cluster running.
  let forwarded
  const running = () => child.exitCode === null && child.signalCode === null
  const forward = signal => {
    if (forwarded) return
    forwarded = signal
    if (!running()) return
    child.kill(signal)
    setTimeout(() => { if (running()) child.kill('SIGKILL') }, 10_000).unref()
  }
  process.on('SIGTERM', () => forward('SIGTERM'))
  process.on('SIGINT', () => forward('SIGINT'))
  const [code, signal] = await new Promise(resolve => child.on('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal])))
  if (managed && process.env.SYNA_PG_KEEP !== '1') stop()
  if (code !== null) return code
  return 128 + (constants.signals[signal] ?? 0)
}

const [action = 'status', ...rest] = process.argv.slice(2)
try {
  switch (action) {
    case 'start': await start(); process.exit(0)
    case 'stop': stop(); process.exit(0)
    case 'status': process.exit(status())
    case 'with': process.exit(await withCommand(rest))
    default:
      console.error(`Unknown action ${action}. Use start | stop | status | with -- <command>`)
      process.exit(2)
  }
}
catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

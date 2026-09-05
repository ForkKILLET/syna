// One gate step = one spawned command, recorded transparently: exit code, timing, TAP counts, log path.
//
// Process control (I-111): every step runs in its own process group (`detached`), so the timeout
// policy reaches the whole tree — the wrapper AND what it spawned — not only the direct child.
// The policy is: SIGTERM to the group (wrappers such as `scripts/pg-test-cluster.mjs with` forward
// the signal to their command, wait for it and stop what they started), SIGKILL to the group after
// `killGraceMs`, and the wait for the stdio `close` event is itself bounded by `closeWaitMs` after
// `exit`, so a stray process that still holds the step's pipes cannot hold the gate.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

/** Parses the summary of node's TAP reporter; `undefined` when the output carries none. */
export function parseTap(output) {
  const get = key => {
    const match = output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))
    return match ? Number(match[1]) : undefined
  }
  const tests = get('tests')
  if (tests === undefined) return undefined
  return { tests, pass: get('pass') ?? 0, fail: get('fail') ?? 0, skipped: get('skipped') ?? 0, todo: get('todo') ?? 0, cancelled: get('cancelled') ?? 0 }
}

const DEFAULTS = { timeoutMs: 20 * 60_000, killGraceMs: 15_000, closeWaitMs: 5_000 }

/** Sends `signal` to the child's process group; falls back to the child alone when no group exists. */
function killGroup(child, signal) {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  }
  catch {
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

/**
 * `onStep` receives every finished step (the gate appends it to its manifest); `run()` resolves with the same object.
 * @param {{ root: string, logsDir: string, log?: (line: string) => void, portable?: (text: string) => string, onStep?: (step: object) => void, defaults?: Partial<typeof DEFAULTS> }} settings
 */
export function createStepRunner({ root, logsDir, log = () => undefined, portable = text => text, onStep = () => undefined, defaults = {} }) {
  const limits = { ...DEFAULTS, ...defaults }
  const active = new Set()

  function run(name, command, commandArgs, options = {}) {
    const logPath = path.join(logsDir, `${name}.log`)
    const started = new Date()
    const timeoutMs = options.timeoutMs ?? limits.timeoutMs
    const killGraceMs = options.killGraceMs ?? limits.killGraceMs
    const closeWaitMs = options.closeWaitMs ?? limits.closeWaitMs
    return new Promise(resolve => {
      const child = spawn(command, commandArgs, {
        cwd: options.cwd ?? root,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
      active.add(child)
      const chunks = []
      child.stdout.on('data', chunk => chunks.push(chunk))
      child.stderr.on('data', chunk => chunks.push(chunk))
      const timers = []
      const later = (fn, ms) => { timers.push(setTimeout(fn, ms)) }
      let timedOut = false
      let closeTimedOut = false
      let spawnError
      let settled = false
      let exit

      const finish = (code, signal) => {
        if (settled) return
        settled = true
        active.delete(child)
        for (const timer of timers) clearTimeout(timer)
        const output = Buffer.concat(chunks).toString('utf8')
        writeFileSync(logPath, output)
        const counts = parseTap(output)
        const notRun = counts ? counts.skipped + counts.todo + counts.cancelled : 0
        const step = {
          name,
          command: portable([command, ...commandArgs].join(' ')),
          ...(options.env ? { env: Object.fromEntries(Object.entries(options.env).map(([key, value]) => [key, portable(String(value))])) } : {}),
          cwd: path.relative(root, options.cwd ?? root) || '.',
          startedAt: started.toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - started.getTime(),
          exitCode: code,
          signal,
          ...(timedOut ? { timedOut: true } : {}),
          ...(closeTimedOut ? { closeTimedOut: true } : {}),
          ...(spawnError ? { spawnError } : {}),
          ...(counts ? { tests: counts } : {}),
          mustRun: options.mustRun ?? true,
          log: path.relative(root, logPath),
          // skipped, todo and cancelled tests all count as "not run" for a no-skip step.
          // A step that leaves a process behind holding its pipes (closeTimedOut) is not ok either: it leaked.
          ok: code === 0 && !timedOut && !closeTimedOut && !spawnError && (counts ? counts.fail === 0 && counts.cancelled === 0 && (!options.noSkip || notRun === 0) : true),
        }
        // A step may also have to say something: an exit code alone does not prove a demo served its pages.
        if (step.ok && options.expectStdout && !options.expectStdout(output)) {
          step.ok = false
          step.note = 'exit 0, but the expected output lines are missing (expectStdout)'
        }
        if (timedOut) step.note = `timed out after ${timeoutMs} ms (SIGTERM to the process group, SIGKILL after ${killGraceMs} ms)`
        if (closeTimedOut) step.note = `${step.note ? `${step.note}; ` : ''}stdio not released within ${closeWaitMs} ms of exit (a process outside the step's group still held the pipes)`
        log(`${step.ok ? 'ok  ' : 'FAIL'} ${name} (exit ${code}${signal ? `/${signal}` : ''}, ${step.durationMs} ms${counts ? `, tests ${counts.pass}/${counts.tests} pass, ${counts.fail} fail, ${notRun} not run` : ''}${step.note ? `; ${step.note}` : ''})`)
        onStep(step)
        resolve(step)
      }

      // Timeout: ask the whole group politely first, then kill it.
      later(() => {
        timedOut = true
        killGroup(child, 'SIGTERM')
        later(() => killGroup(child, 'SIGKILL'), killGraceMs)
      }, timeoutMs)
      child.on('error', error => {
        spawnError = error.message
        chunks.push(Buffer.from(`spawn error: ${error.message}\n`))
        finish(null, null)
      })
      child.on('exit', (code, signal) => {
        exit = { code, signal }
        // 'close' normally follows at once; it is what guarantees the output is complete. Bounded so
        // that a process outside the group holding the pipes cannot hold the gate.
        later(() => {
          closeTimedOut = true
          child.stdout.destroy()
          child.stderr.destroy()
          finish(code, signal)
        }, closeWaitMs)
      })
      child.on('close', (code, signal) => finish(code ?? exit?.code ?? null, signal ?? exit?.signal ?? null))
    })
  }

  /** Ends every running step (their whole process groups) and resolves once they have closed or `waitMs` passed. */
  function abort(signal = 'SIGTERM', waitMs = 10_000) {
    for (const child of active) killGroup(child, signal)
    return new Promise(resolve => {
      const deadline = Date.now() + waitMs
      const poll = () => {
        if (active.size === 0 || Date.now() >= deadline) resolve(active.size)
        else setTimeout(poll, 50)
      }
      poll()
    })
  }

  return { run, abort, active }
}

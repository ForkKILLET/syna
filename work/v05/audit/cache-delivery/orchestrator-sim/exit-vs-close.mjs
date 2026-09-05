// Replicates scripts/verify-v05.mjs run(): collects stdout/stderr chunks and finalizes on child 'exit'.
// Question: can the TAP summary (written last) be missing from the collected output when the child writes a lot?
import { spawn } from 'node:child_process'
const child = (event) => new Promise(resolve => {
  const proc = spawn(process.execPath, ['-e', `
    const big = 'x'.repeat(8 * 1024 * 1024)
    process.stdout.write(big)
    process.stdout.write('\\n# tests 1\\n# pass 1\\n', () => process.exit(0))
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = []
  proc.stdout.on('data', c => chunks.push(c)); proc.stderr.on('data', c => chunks.push(c))
  proc.on(event, () => { const out = Buffer.concat(chunks).toString('utf8'); resolve({ event, bytes: out.length, hasSummary: /^# tests 1$/m.test(out) }) })
})
const results = []
for (let i = 0; i < 5; i += 1) results.push(await child('exit'))
for (let i = 0; i < 5; i += 1) results.push(await child('close'))
console.log(JSON.stringify(results))

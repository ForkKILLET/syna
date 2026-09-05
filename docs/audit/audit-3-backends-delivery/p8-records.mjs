// p8 — Records versus what the scripts do (read-only checks; writes only VALIDATION.regenerated.md next to this file).
//
// Run: node <this file>   (from anywhere; paths are resolved from this file's location)
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../../..')
const read = file => readFileSync(path.join(root, file), 'utf8')
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

// 1. docs/VALIDATION.md versus the generator that is said to produce it (I-83 "FIXED": wording and artefact table).
const validation = read('docs/VALIDATION.md')
const regeneratedPath = path.join(here, 'VALIDATION.regenerated.md')
const generator = spawnSync(process.execPath, ['scripts/validation-doc.mjs', 'validation/v0.5-release', path.relative(root, regeneratedPath)], { cwd: root, encoding: 'utf8' })
check('the generator runs on the recorded release run', generator.status === 0, generator.stderr.trim().slice(0, 200))
const regenerated = existsSync(regeneratedPath) ? readFileSync(regeneratedPath, 'utf8') : ''
check('docs/VALIDATION.md is the output of scripts/validation-doc.mjs for the recorded run', regenerated === validation, {
  committedTotalsLine: validation.split('\n').find(line => line.startsWith('Totals:')),
  regeneratedTotalsLine: regenerated.split('\n').find(line => line.startsWith('Totals:')),
})
check('docs/VALIDATION.md distinguishes distinct cases from re-executions (I-83 wording)', /distinct cases/.test(validation))
check('docs/VALIDATION.md no longer carries the artefact hash table (I-83: replaced by a pointer)', !/\| artefact \| bytes \| sha256 \|/.test(validation))

// 2. "nothing is hand-typed": the PostgreSQL server version quoted in VALIDATION.md must come from the run directory.
const runDir = path.join(root, 'validation', 'v0.5-release')
const runFiles = [...readdirSync(runDir).filter(name => name.endsWith('.json') || name.endsWith('.txt')).map(name => path.join(runDir, name)), ...readdirSync(path.join(runDir, 'logs')).map(name => path.join(runDir, 'logs', name))]
const versionRecorded = runFiles.some(file => /PostgreSQL 17|17\.10|postgresql@17/.test(readFileSync(file, 'utf8')))
const quoted = validation.split('\n').find(line => /postgresql@17/.test(line)) ?? ''
check('the PostgreSQL server version VALIDATION.md quotes is recorded in the run directory it was generated from', versionRecorded, { quoted: quoted.slice(quoted.indexOf('server binaries')), generatorLine: read('scripts/validation-doc.mjs').split('\n').findIndex(line => /postgresql@17/.test(line)) + 1 })

// 3. "the gate fails on any deviation" (VALIDATION.md paragraph 2): verify-v05.mjs compares nothing with a previous run.
const gate = read('scripts/verify-v05.mjs')
check('verify-v05.mjs reads a previous manifest to detect a deviation in step list or test counts', /readFileSync\([^)]*manifest\.json/.test(gate) || /previous/i.test(gate), { claim: validation.split('\n')[4]?.slice(0, 160) })

// 4. Demo cell count in the words versus the three cells the gate asserts.
const cellsAsserted = (gate.match(/HTTP alpha|HTTP beta|static alpha/g) ?? []).length
check('ci.yml / CLI help describe the demo with the cell count the gate asserts', !/four-cell/.test(read('.github/workflows/ci.yml')) && !/four-cell/.test(read('apps/hyla-mini/bin/hyla-mini.mjs')), { cellsAssertedByGate: cellsAsserted, ci: /four-cell/.test(read('.github/workflows/ci.yml')), cli: /four-cell/.test(read('apps/hyla-mini/bin/hyla-mini.mjs')) })

// 5. The recorded run versus HEAD (validation/README.md: "Any source change invalidates the recorded fingerprint and requires a new run").
const manifest = JSON.parse(read('RELEASE_MANIFEST.json'))
const recorded = manifest.environment.gitProvenance.commit
const head = git(['rev-parse', 'HEAD'])
const changed = git(['diff', '--name-only', `${recorded}..${head}`, '--', 'packages', 'apps', 'benchmarks', 'docs', 'scripts', '.github', 'package.json', 'package-lock.json']).split('\n').filter(Boolean)
console.log(`records: RELEASE_MANIFEST.json is the run on ${recorded.slice(0, 7)} (${manifest.totals.tests} test executions, no distinctTests field: pre-I-83 manifest); HEAD is ${head.slice(0, 7)}; ${changed.length} archived source files changed in between`)
check('RELEASE_MANIFEST.json / validation/v0.5-release record a run of the source at HEAD', changed.length === 0, { recorded: recorded.slice(0, 7), head: head.slice(0, 7), changedFiles: changed.length, sample: changed.slice(0, 6) })
check('the recorded manifest carries the I-83 totals (distinctTests / rebuildTests)', typeof manifest.totals.distinctTests === 'number', Object.keys(manifest.totals))

// 6. The archived documentation points at ledgers and probes the archive does not contain (listSourceFiles() never includes `work/`).
const archivedDocs = ['docs/AUDIT.md', 'docs/VALIDATION.md', 'README.md', 'CHANGELOG.md']
const references = Object.fromEntries(archivedDocs.map(file => [file, (read(file).match(/work\/v05\//g) ?? []).length]).filter(([, count]) => count > 0))
const includesWork = /include = \[[^\]]*'work'/.test(gate)
const tarball = path.join(root, 'work', 'release', 'syna-v0.5.0-source.tar.gz')
const tarballWorkEntries = existsSync(tarball)
  ? execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(entry => entry.startsWith('syna-v0.5.0-source/work/')).length
  : 'no tarball present'
check('the archived documents reference only paths the source archive contains (work/v05 ledgers and probes)', Object.keys(references).length === 0 || includesWork, { referencesToWorkV05: references, archiveIncludesWork: includesWork, tarballEntriesUnderWork: tarballWorkEntries })

// 7. The `demos` gate step (npm run demo: minimal, hyla, fluida, features) has no expectStdout and the demos assert nothing:
//    it passes on exit code alone — the class of weakness I-82 closed for the Hyla-mini demo only.
const demosStep = gate.split('\n').find(line => /run\('demos'/.test(line)) ?? ''
const demoAssertions = Object.fromEntries(['apps/minimal-demo', 'apps/hyla-demo', 'apps/fluida-demo', 'apps/features-demo'].map(dir => {
  const src = path.join(root, dir, 'src')
  const files = existsSync(src) ? readdirSync(src, { recursive: true }).filter(name => String(name).endsWith('.ts')) : []
  return [dir, files.reduce((sum, name) => sum + (readFileSync(path.join(src, String(name)), 'utf8').match(/assert|throw new|process\.exit/g) ?? []).length, 0)]
}))
check("the `demos` step asserts its output (expectStdout) or the demos assert their own results", /expectStdout/.test(demosStep) || Object.values(demoAssertions).every(count => count > 0), { step: demosStep.trim(), assertionsPerDemo: demoAssertions })

// 8. verify-v05.mjs:48 assumes the cluster wrapper reacts to SIGTERM.
check('scripts/pg-test-cluster.mjs installs a SIGTERM handler (assumed by verify-v05.mjs:48-49)', /SIGTERM/.test(read('scripts/pg-test-cluster.mjs')), { verifyComment: gate.split('\n').slice(47, 49).map(line => line.trim()) })

process.exitCode = failed === 0 ? 0 : 1

// v0.6 (Phase D/F): the README's one-screen example is compiled and executed exactly as printed. The `package.json`
// and the three `src/*.ts` blocks under "## Syna in one screen" are written to a scratch package that resolves `@syna/core`
// through this workspace's node_modules, built with the workspace TypeScript under the workspace's strict
// options, and run; stdout must equal the output block. README.zh-CN.md carries the same blocks, and the
// Phase A record `work/v06/README_EXAMPLE.md` (when present) must match too.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const root = new URL('../../', import.meta.url).pathname.replace(/\/$/, '')

function exampleOf(markdown, heading) {
  const start = markdown.indexOf(`## ${heading}`)
  assert.ok(start >= 0, `section "${heading}" not found`)
  const rest = markdown.slice(start + heading.length + 3)
  const next = rest.search(/^## /m)
  const section = next >= 0 ? rest.slice(0, next) : rest
  const matches = [...section.matchAll(/^`(package\.json|src\/[\w-]+\.ts)`\n\n```(?:json|ts)\n([\s\S]*?)```/gm)]
  const files = matches.map(match => ({ file: match[1], code: match[2] }))
  const last = matches.at(-1)
  const output = last ? section.slice(last.index + last[0].length).match(/```\n([\s\S]*?)```/)?.[1] : undefined
  return { files, output }
}

const english = exampleOf(readFileSync(join(root, 'README.md'), 'utf8'), 'Syna in one screen')

test('README.md carries three comment-free files and their output; README.zh-CN.md and the Phase A record carry the same', () => {
  assert.deepEqual(english.files.map(item => item.file), ['package.json', 'src/greeter.ts', 'src/conversation.ts', 'src/main.ts'])
  assert.deepEqual(Object.keys(JSON.parse(english.files[0].code)), ['name', 'version', 'type', 'imports'])
  for (const { file, code } of english.files.slice(1)) {
    assert.ok(!/\/\/|\/\*/.test(code), `${file} must not carry explanatory comments`)
  }
  assert.ok(english.output, 'the output block follows the files')
  const chinese = exampleOf(readFileSync(join(root, 'README.zh-CN.md'), 'utf8'), '一屏示例')
  assert.deepEqual(chinese, english, 'README.zh-CN.md carries the same blocks and output')
  const record = join(root, 'work/v06/README_EXAMPLE.md')
  if (existsSync(record)) {
    const text = readFileSync(record, 'utf8')
    const files = [...text.matchAll(/^`(package\.json|src\/[\w-]+\.ts)`\n\n```(?:json|ts)\n([\s\S]*?)```/gm)].map(match => ({ file: match[1], code: match[2] }))
    assert.deepEqual(files, english.files, 'work/v06/README_EXAMPLE.md matches README.md')
    assert.equal(text.match(/Expected output when run \(`node dist\/main\.js`\):\n\n```\n([\s\S]*?)```/)?.[1], english.output)
  }
})

test('the README example compiles under the workspace options and prints the documented output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'syna-readme-'))
  try {
    mkdirSync(join(directory, 'src'))
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir')
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({
      extends: '@syna/tsconfig/node-app.json',
      compilerOptions: { rootDir: 'src', outDir: 'dist', composite: false, incremental: false, sourceMap: false },
      include: ['src/**/*.ts'],
    }, null, 2))
    for (const { file, code } of english.files) writeFileSync(join(directory, file), code)
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--pretty', 'false'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
    const stdout = execFileSync(process.execPath, ['dist/main.js'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30_000 })
    assert.equal(stdout, english.output)
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

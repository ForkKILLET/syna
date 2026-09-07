// v0.8 (§2.6): `scripts/api-inventory.mjs --diff` tells a change of documentation from a change of signature. An item
// whose signature and deprecation are unchanged but whose JSDoc differs is listed under "Doc-only changes", never under
// "Changed"; a changed signature is "Changed" whatever its JSDoc did; a record made before the `doc` field reads as ''.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = new URL('../../', import.meta.url).pathname.replace(/\/$/, '')

const record = (version, items) => JSON.stringify({ version, commit: 'test', generatedBy: 'test', items })
const item = (path, signature, doc = '', extra = {}) => ({ path, kind: 'member', signature, doc, deprecated: false, note: '', ...extra })

test('--diff separates doc-only (JSDoc) changes from signature changes, additions and removals', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'syna-inventory-diff-'))
  try {
    const before = path.join(dir, 'before.json')
    const after = path.join(dir, 'after.json')
    const out = path.join(dir, 'diff.md')
    writeFileSync(before, record('0.7.0', [
      item('Kept.same', 'readonly same: string', '/** the same doc */'),
      item('Kept.docChanged', 'readonly docChanged: number', '/** the old doc */'),
      item('Kept.signatureChanged', 'readonly signatureChanged: string', '/** a doc */'),
      item('Kept.bothChanged', 'readonly bothChanged: string', '/** old */'),
      item('Kept.noteChanged', 'readonly noteChanged: string', '/** @deprecated old note */', { deprecated: true, note: 'old note' }),
      item('Kept.undocumentedBefore', 'readonly undocumentedBefore: string', ''),
      item('Gone.member', 'readonly member: string', ''),
      // Overloads: several items with one path, compared as a set.
      item('Over.same', 'same(a: string): void', '/** a */'),
      item('Over.same', 'same(b: number): void', '/** b */'),
      item('Over.changed', 'changed(a: string): void', ''),
      item('Over.changed', 'changed(b: number): void', ''),
    ]))
    writeFileSync(after, record('0.8.0', [
      item('Kept.same', 'readonly same: string', '/** the same doc */'),
      item('Kept.docChanged', 'readonly docChanged: number', '/** the new doc */'),
      item('Kept.signatureChanged', 'readonly signatureChanged: number', '/** a doc */'),
      item('Kept.bothChanged', 'readonly bothChanged: number', '/** new */'),
      item('Kept.noteChanged', 'readonly noteChanged: string', '/** @deprecated new note */', { deprecated: true, note: 'new note' }),
      item('Kept.undocumentedBefore', 'readonly undocumentedBefore: string', '/** documented now */'),
      item('New.member', 'readonly member: string', '/** new */'),
      item('Over.same', 'same(b: number): void', '/** b */'),
      item('Over.same', 'same(a: string): void', '/** a */'),
      item('Over.changed', 'changed(a: string): void', ''),
      item('Over.changed', 'changed(b: boolean): void', ''),
    ]))
    execFileSync(process.execPath, ['scripts/api-inventory.mjs', '--diff', before, after, '--out', out], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    const markdown = readFileSync(out, 'utf8')
    const section = title => {
      const start = markdown.indexOf(`## ${title}`)
      assert.ok(start >= 0, `section ${title}`)
      const rest = markdown.slice(start + 3)
      const end = rest.search(/^## /m)
      return end >= 0 ? rest.slice(0, end) : rest
    }
    const paths = text => [...text.matchAll(/^([A-Za-z.\[\]']+)  ::  /gm)].map(match => match[1])
    assert.deepEqual(paths(section('Added (1)')), ['New.member'])
    assert.deepEqual(paths(section('Removed (1)')), ['Gone.member'])
    const changed = section('Changed (signature or deprecation) (3)')
    assert.deepEqual([...changed.matchAll(/^\+ ([A-Za-z.]+)  ::  /gm)].map(match => match[1]), ['Kept.signatureChanged', 'Kept.bothChanged', 'Over.changed', 'Over.changed'], 'every overload of a changed path is printed; a path whose overloads are the same set in another order is not changed')
    assert.match(changed, /^- Over\.changed  ::  changed\(b: number\): void\n\+ Over\.changed  ::  changed\(a: string\): void\n\+ Over\.changed  ::  changed\(b: boolean\): void$/m)
    assert.ok(!changed.includes('Over.same'))
    const docOnly = section('Doc-only changes (JSDoc; the signature is identical) (3)')
    assert.deepEqual([...docOnly.matchAll(/^([A-Za-z.]+)$/gm)].map(match => match[1]), ['Kept.docChanged', 'Kept.noteChanged', 'Kept.undocumentedBefore'])
    assert.match(docOnly, /^- \/\*\* the old doc \*\/\n\+ \/\*\* the new doc \*\/$/m)
    assert.match(docOnly, /^- \(no JSDoc\)\n\+ \/\*\* documented now \*\/$/m)
    assert.ok(!docOnly.includes('Kept.same') && !docOnly.includes('Over.same'), 'an unchanged item is listed nowhere')
    assert.match(markdown, /^\| total items \| 11 \| 11 \| 1 \| 1 \| 3 \| 3 \| 0 \|$/m, 'the summary row counts the two kinds apart, one per path')
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the inventory records the JSDoc of exports and members, and a documented member differs from an undocumented one only in `doc`', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'syna-inventory-doc-'))
  try {
    const file = path.join(dir, 'after.json')
    execFileSync(process.execPath, ['scripts/api-inventory.mjs', '--json', file], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    const inventory = JSON.parse(readFileSync(file, 'utf8'))
    const byPath = new Map(inventory.items.map(entry => [entry.path, entry]))
    assert.ok(inventory.items.every(entry => typeof entry.doc === 'string'), 'every item carries a doc string')
    assert.match(byPath.get('RuntimeLimits').doc, /^\/\*\*.*Defaults:.*\*\/$/, 'the RuntimeLimits JSDoc is recorded')
    assert.match(byPath.get('RuntimeLimits.loadTimeoutMs').doc, /LOAD_TIMEOUT/, 'a member JSDoc is recorded')
    assert.equal(byPath.get("SynaErrorCode['LOAD_TIMEOUT']").doc, '', 'a union member has no JSDoc of its own')
    assert.equal(byPath.get('Env.id').doc, '', 'an undocumented member reads as an empty doc')
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

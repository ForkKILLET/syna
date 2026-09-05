import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareVersions,
  normalizeVersion,
  parseVersion,
  satisfiesVersion,
} from '../dist/semver.js'

test('semantic versions parse and normalize package-style versions', () => {
  assert.deepEqual(parseVersion('1'), { major: 1, minor: 0, patch: 0 })
  assert.deepEqual(parseVersion('1.2.3-beta.2'), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: 'beta.2',
  })
  assert.equal(normalizeVersion(' 2.4 '), '2.4.0')
  assert.throws(() => parseVersion('not-a-version'), /Invalid semantic version/)
})

test('semantic version comparison follows numeric prerelease precedence', () => {
  assert.equal(Math.sign(compareVersions('2.0.0', '1.9.9')), 1)
  assert.equal(Math.sign(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')), -1)
  assert.equal(Math.sign(compareVersions('1.0.0-beta', '1.0.0-beta.1')), -1)
  assert.equal(Math.sign(compareVersions('1.0.0-beta.1', '1.0.0-beta.x')), -1)
  assert.equal(Math.sign(compareVersions('1.0.0', '1.0.0-rc.1')), 1)
})

test('the bounded v0 range grammar covers exact, caret, tilde, wildcard and comparator forms', () => {
  assert.equal(satisfiesVersion('2.4.1', '2.4.1'), true)
  assert.equal(satisfiesVersion('2.4.1', '*'), true)
  assert.equal(satisfiesVersion('2.4.1', 'latest'), true)
  assert.equal(satisfiesVersion('2.4.1', '^2.3.0'), true)
  assert.equal(satisfiesVersion('3.0.0', '^2.3.0'), false)
  assert.equal(satisfiesVersion('0.4.8', '^0.4.2'), true)
  assert.equal(satisfiesVersion('0.5.0', '^0.4.2'), false)
  assert.equal(satisfiesVersion('0.0.4', '^0.0.4'), true)
  assert.equal(satisfiesVersion('0.0.5', '^0.0.4'), false)
  assert.equal(satisfiesVersion('2.4.9', '~2.4.1'), true)
  assert.equal(satisfiesVersion('2.5.0', '~2.4.1'), false)
  assert.equal(satisfiesVersion('2.4.9', '2.x'), true)
  assert.equal(satisfiesVersion('2.4.9', '2.4.*'), true)
  assert.equal(satisfiesVersion('2.4.9', '>=2.2 <3'), true)
  assert.equal(satisfiesVersion('3.0.0', '>=2.2 <3'), false)
  assert.throws(
    () => satisfiesVersion('2.4.9', 'definitely-not-a-range'),
    /Invalid semantic version/,
  )
})

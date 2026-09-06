// syna-v05-compat — Syna 0.6 (R5), kept in 0.7: stored implementation references carry `familyId`; documents written by
// Hyla-mini on Syna 0.5 carry the same value under `implementationId`. Both parse at the store boundary and come out
// in the `familyId` shape, so a 0.5 content root keeps working without a rewrite. The 0.5 key is read permanently
// (docs/MIGRATION_V06_TO_V07.md); the Runtime's own `legacy-implementation-ref` event never fires for Hyla-mini data.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRecipeDocument } from '../dist/render/recipe.js'
import { parseSiteConfig } from '../dist/domain/site-config.js'
import { normalizeStoredImplementationRef } from '../dist/domain/recipe-schema.js'

// syna-v05-compat: the old key is the subject of this test.
const LEGACY_KEY = 'implementationId'
const legacyRef = (familyId, version = '^1.0.0') => ({ kind: 'persistent-implementation-ref', contractId: 'hyla.mini/markdown-stage-factory/v1', [LEGACY_KEY]: familyId, version })
const currentRef = (familyId, version = '^1.0.0') => ({ kind: 'persistent-implementation-ref', contractId: 'hyla.mini/markdown-stage-factory/v1', familyId, version })
const recipe = (name, ref) => ({
  formatVersion: 1,
  name,
  stages: [
    { occurrence: 'parse', ref: ref('hyla.mini/remark-parse'), optionsVersion: 1, options: {} },
    { occurrence: 'bridge', ref: ref('hyla.mini/remark-rehype'), optionsVersion: 1, options: {} },
    { occurrence: 'compile', ref: ref('hyla.mini/rehype-stringify'), optionsVersion: 1, options: {} },
  ],
})
const siteConfig = ref => ({
  tenantId: 'alpha',
  title: 'Alpha',
  domains: ['alpha.test'],
  defaultLocale: 'en',
  theme: { name: 'plain', accent: '#336699' },
  navigation: [{ label: 'Home', href: '/' }],
  recipes: { body: recipe('body', ref), comment: recipe('comment', ref), preview: recipe('preview', ref) },
  auth: { implementation: { ...ref('hyla.mini/test-auth'), contractId: 'hyla.mini/auth/v1' }, options: {} },
  configRevision: 3,
})

test('a recipe written by 0.5 parses and its stage refs come out with familyId', () => {
  const parsed = parseRecipeDocument(recipe('body', legacyRef))
  assert.deepEqual(parsed, parseRecipeDocument(recipe('body', currentRef)))
  assert.deepEqual(parsed.stages.map(stage => stage.ref), [currentRef('hyla.mini/remark-parse'), currentRef('hyla.mini/remark-rehype'), currentRef('hyla.mini/rehype-stringify')])
  assert.ok(parsed.stages.every(stage => !(LEGACY_KEY in stage.ref)))
})

test('a stored site configuration written by 0.5 parses in both modes and comes out in the 0.6 shape', () => {
  const stored = parseSiteConfig(siteConfig(legacyRef), 'stored')
  assert.deepEqual(stored, parseSiteConfig(siteConfig(currentRef), 'stored'))
  assert.deepEqual(stored.auth.implementation, { kind: 'persistent-implementation-ref', contractId: 'hyla.mini/auth/v1', familyId: 'hyla.mini/test-auth', version: '^1.0.0' })
  assert.ok(stored.recipes.body.stages.every(stage => !(LEGACY_KEY in stage.ref) && typeof stage.ref.familyId === 'string'))
  const input = parseSiteConfig(siteConfig(legacyRef), 'input')
  assert.equal('configRevision' in input, false)
  assert.deepEqual(input.recipes, stored.recipes)
})

test('a reference with both keys must agree; one without either is refused', () => {
  assert.deepEqual(normalizeStoredImplementationRef({ ...currentRef('a'), [LEGACY_KEY]: 'a' }), currentRef('a'))
  assert.throws(() => normalizeStoredImplementationRef({ kind: 'persistent-implementation-ref', contractId: 'c', version: '1' }), TypeError)
  const bare = siteConfig(currentRef)
  bare.auth.implementation = { kind: 'persistent-implementation-ref', contractId: 'hyla.mini/auth/v1', version: '^1.0.0' }
  assert.throws(() => parseSiteConfig(bare, 'stored'), { name: 'SiteConfigError' })
})

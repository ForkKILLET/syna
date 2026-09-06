// syna-v05-compat: stored references written on Syna 0.5 carry `implementationId`; accepted until 0.7.0 (docs/MIGRATION_V05_TO_V06.md).
/**
 * JSON schema of a recipe document. Lives in the domain layer because the site
 * configuration schema embeds it (a stored SiteConfig carries three recipes);
 * `render/recipe.ts` compiles it for the pipeline builder.
 */
import type { StoredImplementationRef } from './model.js'

export const RECIPE_FORMAT_VERSION = 1

/**
 * A stored implementation reference: Syna 0.6 writes `familyId`; documents
 * written by 0.5 carry `implementationId`. Both are accepted until the 0.7.0
 * line drops the old key (docs/MIGRATION_V05_TO_V06.md).
 */
export const storedImplementationRefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractId', 'version'],
  properties: {
    kind: { const: 'persistent-implementation-ref' },
    contractId: { type: 'string', minLength: 1 },
    familyId: { type: 'string', minLength: 1 },
    implementationId: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
  },
  // Syna 0.6 writes `familyId`; documents written on Syna 0.5 carry `implementationId` (accepted until 0.7.0).
  anyOf: [
    { required: ['familyId'], properties: { familyId: { type: 'string', minLength: 1 } } },
    { required: ['implementationId'], properties: { implementationId: { type: 'string', minLength: 1 } } },
  ],
} as const

/** The 0.6 shape of a validated stored reference (`familyId` from either key). */
export function normalizeStoredImplementationRef(ref: { readonly kind: 'persistent-implementation-ref'; readonly contractId: string; readonly familyId?: string; readonly implementationId?: string; readonly version: string }): StoredImplementationRef {
  const familyId = ref.familyId ?? ref.implementationId
  if (familyId === undefined) throw new TypeError('A stored implementation reference needs familyId.')
  return { kind: 'persistent-implementation-ref', contractId: ref.contractId, familyId, version: ref.version }
}

export const recipeDocumentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['formatVersion', 'name', 'stages'],
  properties: {
    formatVersion: { const: RECIPE_FORMAT_VERSION },
    name: { type: 'string', minLength: 1, maxLength: 64 },
    stages: {
      type: 'array',
      minItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['occurrence', 'ref', 'optionsVersion', 'options'],
        properties: {
          occurrence: { type: 'string', minLength: 1, maxLength: 64 },
          ref: storedImplementationRefSchema,
          optionsVersion: { type: 'integer', minimum: 1 },
          options: { type: 'object' },
        },
      },
    },
  },
} as const

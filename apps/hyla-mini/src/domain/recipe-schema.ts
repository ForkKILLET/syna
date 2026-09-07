/**
 * JSON schema of a recipe document. Lives in the domain layer because the site
 * configuration schema embeds it (a stored SiteConfig carries three recipes);
 * `render/recipe.ts` compiles it for the pipeline builder.
 */
export const RECIPE_FORMAT_VERSION = 1

/**
 * A stored implementation reference: the one shape Syna writes and reads,
 * `{ kind: 'implementation-ref', contractId, familyId, range }`. A document in
 * any other shape (the pre-0.8 kind, the pre-0.8 `version` key, the 0.5 family
 * key) is refused at the store boundary; see docs/MIGRATION_V07_TO_V08.md.
 */
export const storedImplementationRefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractId', 'familyId', 'range'],
  properties: {
    kind: { const: 'implementation-ref' },
    contractId: { type: 'string', minLength: 1 },
    familyId: { type: 'string', minLength: 1 },
    range: { type: 'string', minLength: 1 },
  },
} as const

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

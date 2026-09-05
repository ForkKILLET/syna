/**
 * JSON schema of a recipe document. Lives in the domain layer because the site
 * configuration schema embeds it (a stored SiteConfig carries three recipes);
 * `render/recipe.ts` compiles it for the pipeline builder.
 */
export const RECIPE_FORMAT_VERSION = 1

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
          ref: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'contractId', 'implementationId', 'version'],
            properties: {
              kind: { const: 'persistent-implementation-ref' },
              contractId: { type: 'string', minLength: 1 },
              implementationId: { type: 'string', minLength: 1 },
              version: { type: 'string', minLength: 1 },
            },
          },
          optionsVersion: { type: 'integer', minimum: 1 },
          options: { type: 'object' },
        },
      },
    },
  },
} as const

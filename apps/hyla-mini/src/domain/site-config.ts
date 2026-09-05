import { Ajv, type ValidateFunction } from 'ajv'
import { LOCALES, isSafeSegment, normalizeDomain, type SiteConfig, type SiteConfigInput } from './model.js'
import { recipeDocumentSchema } from './recipe-schema.js'

/**
 * Validation of site configurations at the store boundary. `input` is what a
 * caller saves (its `configRevision`, if any, is ignored: the store assigns
 * one); `stored` is what a store reads back, which must carry the revision.
 * A stored configuration that fails (an out-of-band edit, a raw database
 * update, a document written by an older or foreign program) is a typed error
 * for that tenant, never a page rendered from garbage.
 */
export type SiteConfigMode = 'input' | 'stored'

export class SiteConfigError extends Error {
  readonly code = 'INVALID_SITE_CONFIG'
  readonly tenantId: string | undefined
  readonly mode: SiteConfigMode
  readonly problems: readonly string[]
  constructor(tenantId: string | undefined, mode: SiteConfigMode, problems: readonly string[]) {
    super(`Invalid ${mode} site configuration${tenantId ? ` for tenant ${tenantId}` : ''}: ${problems.join('; ')}`)
    this.name = 'SiteConfigError'
    this.tenantId = tenantId
    this.mode = mode
    this.problems = problems
  }
}

const storedRefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractId', 'implementationId', 'version'],
  properties: {
    kind: { const: 'persistent-implementation-ref' },
    contractId: { type: 'string', minLength: 1 },
    implementationId: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
  },
} as const

export const siteConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tenantId', 'title', 'domains', 'defaultLocale', 'theme', 'navigation', 'recipes', 'auth'],
  properties: {
    tenantId: { type: 'string', minLength: 1, maxLength: 64 },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    domains: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 253 } },
    defaultLocale: { enum: [...LOCALES] },
    theme: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'accent'],
      properties: {
        name: { type: 'string', pattern: '^[a-z0-9-]{1,32}$' },
        accent: { type: 'string', minLength: 1, maxLength: 64 },
      },
    },
    navigation: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'href'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 64 },
          href: { type: 'string', minLength: 1, maxLength: 2048 },
        },
      },
    },
    recipes: {
      type: 'object',
      additionalProperties: false,
      required: ['body', 'comment', 'preview'],
      properties: { body: recipeDocumentSchema, comment: recipeDocumentSchema, preview: recipeDocumentSchema },
    },
    auth: {
      type: 'object',
      additionalProperties: false,
      required: ['implementation', 'options'],
      properties: { implementation: storedRefSchema, options: { type: 'object' } },
    },
    configRevision: { type: 'integer', minimum: 1 },
  },
} as const

// No `useDefaults`: validation never rewrites a configuration.
const ajv = new Ajv({ allErrors: true, strict: true })
const validateShape: ValidateFunction = ajv.compile(siteConfigSchema)

const NAMED_COLORS = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown '
  + 'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray '
  + 'darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue '
  + 'darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite '
  + 'forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory '
  + 'khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen '
  + 'lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime '
  + 'limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue '
  + 'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive '
  + 'olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum '
  + 'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue '
  + 'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke '
  + 'yellow yellowgreen transparent currentcolor').split(' '))

/**
 * A CSS `<color>` that can only be a color: hex (3/4/6/8 digits), `rgb()`,
 * `rgba()`, `hsl()`, `hsla()` with numeric arguments, or a named color. The
 * value is interpolated into a stylesheet, so anything that could close the
 * declaration or the style element (`;`, `}`, `<`, `/`) is refused by shape.
 */
export function isCssColor(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false
  const text = value.trim().toLowerCase()
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(text)) return true
  if (/^(?:rgb|rgba|hsl|hsla)\(\s*[0-9][0-9.%\s,/-]*\)$/.test(text)) return true
  return NAMED_COLORS.has(text)
}

/**
 * A navigation `href` that cannot run script or leave the site by surprise: a
 * same-site path (`/…`, `./…`, `posts/…`), a fragment, or an absolute `http`,
 * `https` or `mailto` URL. Anything with another scheme (`javascript:`, `data:`,
 * `vbscript:`), a protocol-relative `//host` (or a backslash spelling of it:
 * browsers parse `\` as `/` in these URLs, so `/\host` leaves the site too),
 * control characters or whitespace is refused.
 */
export function isSafeHref(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false
  if (/[\p{Cc}\s\\]/u.test(value)) return false
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)
  if (scheme) return ['http', 'https', 'mailto'].includes(scheme[1]!.toLowerCase())
  return !value.startsWith('//')
}

export function parseSiteConfig(value: unknown, mode: 'input'): SiteConfigInput
export function parseSiteConfig(value: unknown, mode: 'stored'): SiteConfig
export function parseSiteConfig(value: unknown, mode: SiteConfigMode): SiteConfigInput | SiteConfig {
  const tenantId = typeof value === 'object' && value !== null && typeof (value as { tenantId?: unknown }).tenantId === 'string'
    ? (value as { tenantId: string }).tenantId
    : undefined
  const problems: string[] = []
  if (!validateShape(value)) {
    problems.push(...(validateShape.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`))
    throw new SiteConfigError(tenantId, mode, problems)
  }
  const config = value as SiteConfig
  if (!isSafeSegment(config.tenantId)) problems.push('/tenantId must be a lower-case path-safe segment')
  // JSON.stringify writes U+0000 as the six-character escape: one pass over the whole document (F-BD3-12).
  if (JSON.stringify(config).includes('\\u0000')) problems.push('/ must not contain a NUL character in any string')
  if (mode === 'stored' && !(Number.isSafeInteger(config.configRevision) && config.configRevision >= 1)) {
    problems.push('/configRevision must be a positive integer')
  }
  config.domains.forEach((domain, index) => {
    if (normalizeDomain(domain) === undefined) problems.push(`/domains/${index} is not a host name`)
  })
  if (!isCssColor(config.theme.accent)) problems.push('/theme/accent must be a CSS color: hex, rgb()/hsl() with numeric arguments, or a named color')
  config.navigation.forEach((item, index) => {
    if (!isSafeHref(item.href)) problems.push(`/navigation/${index}/href must be a same-site path, a fragment, or an http(s)/mailto URL`)
  })
  if (problems.length > 0) throw new SiteConfigError(tenantId, mode, problems)
  if (mode === 'stored') return config
  const { configRevision: _ignored, ...input } = config
  return input
}

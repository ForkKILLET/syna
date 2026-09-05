export type SynaErrorCode =
  | 'AMBIGUOUS_IMPLEMENTATION'
  | 'MISSING_AUTO_POLICY'
  | 'CIRCULAR_MATERIALIZATION'
  | 'CONSTRAINT_VIOLATION'
  | 'DUPLICATE_DEFINITION'
  | 'ENTRY_ACTIVATION_FAILED'
  | 'INCOMPATIBLE_IMPLEMENTATION'
  | 'INVALID_DESCRIPTOR'
  | 'INVALID_ENV_STATE'
  | 'LINEAGE_UNIQUENESS_CONFLICT'
  | 'MISSING_BINDING'
  | 'MISSING_IMPLEMENTATION'
  | 'MISSING_SERVICE'
  | 'MISSING_INPUT'
  | 'RUNTIME_MISMATCH'
  | 'SHARE_CONSTRAINT_FAILED'
  | 'UNAVAILABLE_IMPLEMENTATION'
  | 'UNSATISFIABLE_TOPOLOGY'

export type DiagnosticCode = SynaErrorCode | 'UNKNOWN_ERROR'

export class SynaError extends Error {
  readonly code: SynaErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: SynaErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SynaError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

export function asSynaError(
  error: unknown,
  code: SynaErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): SynaError {
  if (error instanceof SynaError) return error
  return new SynaError(code, message, details, {
    cause: error instanceof Error ? error : undefined,
  })
}

export function diagnosticFromError(error: unknown): Readonly<{
  code: SynaErrorCode | 'UNKNOWN_ERROR'
  message: string
  details: Readonly<Record<string, unknown>>
}> {
  if (error instanceof SynaError) {
    return Object.freeze({ code: error.code, message: error.message, details: error.details })
  }
  return Object.freeze({
    code: 'UNKNOWN_ERROR',
    message: error instanceof Error ? error.message : String(error),
    details: Object.freeze({}),
  })
}

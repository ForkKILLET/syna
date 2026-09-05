/**
 * Every code a SynaError can carry. Diagnostics (`check()`, `explain()`,
 * candidate availability) use the same union plus `UNKNOWN_ERROR` for foreign
 * errors, so code, throw site and diagnostic schema never drift apart.
 */
export type SynaErrorCode =
  | 'AMBIGUOUS_IMPLEMENTATION'
  | 'CONSTRAINT_VIOLATION'
  | 'DUPLICATE_DEFINITION'
  | 'ENTRY_ACTIVATION_FAILED'
  | 'INCOMPATIBLE_IMPLEMENTATION'
  | 'INITIALIZATION_TIMEOUT'
  | 'INVALID_DESCRIPTOR'
  | 'INVALID_ENV_STATE'
  | 'LINEAGE_UNIQUENESS_CONFLICT'
  | 'LOAD_CANCELLED'
  | 'MISSING_AUTO_POLICY'
  | 'MISSING_BINDING'
  | 'MISSING_IMPLEMENTATION'
  | 'MISSING_INPUT'
  | 'MISSING_SERVICE'
  | 'OWNER_NOT_READY'
  | 'PLANNING_BUDGET_EXCEEDED'
  | 'RUNTIME_MISMATCH'
  | 'SHARE_CONSTRAINT_FAILED'
  | 'UNAVAILABLE_IMPLEMENTATION'
  | 'UNSATISFIABLE_TOPOLOGY'
  | 'UNSETTLED_ATTEMPT'

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

export function isSynaError(error: unknown, code?: SynaErrorCode): error is SynaError {
  return error instanceof SynaError && (code === undefined || error.code === code)
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

export interface Diagnostic {
  readonly code: DiagnosticCode
  readonly message: string
  readonly details: Readonly<Record<string, unknown>>
}

export function diagnosticFromError(error: unknown): Diagnostic {
  if (error instanceof SynaError) {
    return Object.freeze({ code: error.code, message: error.message, details: error.details })
  }
  return Object.freeze({
    code: 'UNKNOWN_ERROR',
    message: error instanceof Error ? error.message : String(error),
    details: Object.freeze({}),
  })
}

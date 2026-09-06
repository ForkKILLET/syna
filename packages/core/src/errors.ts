import type { EnvState, ForkCause, UnsettledAttemptInspection } from './descriptors.js'

/**
 * Every code a SynaError can carry. Diagnostics (`check()`, `explain()`) use
 * the same union plus `UNKNOWN_ERROR` for foreign errors, so code, throw site
 * and diagnostic schema never drift apart.
 */
export type SynaErrorCode =
  | 'AMBIGUOUS_IMPLEMENTATION'
  | 'DUPLICATE_DEFINITION'
  | 'ENTRY_ACTIVATION_FAILED'
  | 'ENV_CLOSED'
  | 'FOREIGN_CANDIDATE_REF'
  | 'INACTIVE_REUSE_TARGET'
  | 'INCOMPATIBLE_IMPLEMENTATION'
  | 'INITIALIZATION_TIMEOUT'
  | 'INVALID_DESCRIPTOR'
  | 'INVALID_INHERITED_CHOICE'
  | 'LIFECYCLE_MISUSE'
  | 'LINEAGE_UNIQUENESS_CONFLICT'
  | 'LOAD_CANCELLED'
  | 'MISSING_AUTO_POLICY'
  | 'MISSING_BINDING'
  | 'MISSING_IMPLEMENTATION'
  | 'MISSING_INPUT'
  | 'MISSING_SERVICE'
  | 'OWNER_NOT_READY'
  | 'PLANNING_BUDGET_EXCEEDED'
  | 'ROLLBACK_FAILED'
  | 'RUNTIME_CLOSED'
  | 'RUNTIME_MISMATCH'
  | 'SHARE_CONSTRAINT_FAILED'
  | 'SLOT_NOT_LOADABLE'
  | 'UNSATISFIABLE_TOPOLOGY'
  | 'UNSETTLED_ATTEMPT'

export type DiagnosticCode = SynaErrorCode | 'UNKNOWN_ERROR'

/** An Entry call that lacks declared parameters (`MISSING_INPUT` when an Input is missing, else `MISSING_BINDING`). */
type EntryParametersMissing = {
  readonly entry: string
  readonly missing: readonly string[]
  readonly missingInputs: readonly string[]
  readonly missingBindings: readonly string[]
}

/** A dependency slot a timed-out setup was still waiting for. */
type PendingLoad = {
  readonly revision: string
  readonly slot: string
  readonly state: string
  readonly waitingMs: number
}

/** A setup attempt an Env close stopped waiting for. */
type AbandonedSlot = {
  readonly slot: string
  readonly revision: string
  readonly attempt: number
  /** `rollback`: the setup already settled; its cleanups are what outlived the grace. */
  readonly phase: 'setup' | 'rollback'
  readonly dependencies: readonly { readonly dependency: string; readonly slot: string; readonly revision: string; readonly state: string }[]
}

/**
 * The `details` of every code, one entry per code. Where a code is thrown
 * from sites with different context, the entry is the union of their shapes;
 * `docs/API_REFERENCE.md` lists them per code.
 */
export type SynaErrorDetails = {
  readonly AMBIGUOUS_IMPLEMENTATION: { readonly contract: string; readonly site: string; readonly families: readonly string[] }
  readonly DUPLICATE_DEFINITION:
    | { readonly existing: string; readonly received: string }
    | { readonly revision: string }
    | { readonly revision: string; readonly expected: string; readonly actual: string }
  readonly ENTRY_ACTIVATION_FAILED: {
    readonly entry: string
    readonly env: string
    readonly causeCode?: SynaErrorCode
    readonly causeDetails?: Readonly<Record<string, unknown>>
  }
  /** An Env-level refusal names the Env; a slot-level one (a load, retry or recovery under a closing owner) names the slot as well. */
  readonly ENV_CLOSED:
    | { readonly env: string; readonly state: EnvState }
    | { readonly env: string; readonly state: EnvState; readonly slot: string; readonly revision: string }
  readonly FOREIGN_CANDIDATE_REF: { readonly expectedSourceSlot: string; readonly receivedSourceSlot: string }
  readonly INACTIVE_REUSE_TARGET:
    | { readonly constraint: 'fresh' | 'share'; readonly env: string; readonly revision: string }
    | { readonly constraint: 'fresh' | 'share'; readonly env: string; readonly family: string }
  readonly INCOMPATIBLE_IMPLEMENTATION:
    | { readonly binding: string; readonly contract: string; readonly reference: string }
    | { readonly binding: string; readonly revision: string }
    | { readonly contract: string; readonly reference: string }
    | {
        readonly family: string
        readonly range: string
        readonly site: string
        readonly realm: string
        readonly origin: string
        readonly required: readonly string[]
        readonly candidates: readonly { readonly revision: string; readonly provides: readonly string[] }[]
      }
  readonly INITIALIZATION_TIMEOUT: {
    readonly slot: string
    readonly revision: string
    readonly env: string
    readonly attempt: number
    readonly deadlineMs: number
    readonly elapsedMs: number
    readonly pendingLoads: readonly PendingLoad[]
    readonly suspectedWaitCycle?: readonly string[]
    readonly note: string
  }
  /**
   * `descriptor` names the expected descriptor kind, the option, or the id / key
   * of the offending descriptor; `problem` is one token of a closed vocabulary
   * (`not-an-object`, `not-an-array`, `wrong-kind`, `unknown-kind`,
   * `empty-contract-id`, `self-override`, `override-cycle`, `forward-cycle`,
   * `not-service-revisions`, `parameters-not-an-object`, `invalid-assignment`,
   * `not-from-this-runtime`, `policy-result-not-an-array`,
   * `policy-result-not-a-permutation`); `site` where a dependency site exists,
   * `path` where a chain (an override cycle) exists.
   */
  readonly INVALID_DESCRIPTOR: {
    readonly descriptor: string
    readonly problem: string
    readonly site?: string
    readonly path?: readonly string[]
  }
  readonly INVALID_INHERITED_CHOICE: { readonly site: string; readonly selectedKey: string; readonly candidates: readonly string[] }
  /** `onDispose()` called on a lifecycle whose setup attempt already settled; `state` is the attempt's. */
  readonly LIFECYCLE_MISUSE: { readonly slot: string; readonly revision: string; readonly attempt: number; readonly state: string }
  readonly LINEAGE_UNIQUENESS_CONFLICT:
    | {
        readonly family: string
        readonly anchorRevision: string
        readonly anchorSlot: string
        readonly attempted: readonly { readonly revision: string; readonly slot: string; readonly cause: ForkCause | undefined; readonly path: readonly string[] }[]
      }
    | { readonly family: string; readonly slots: readonly string[] }
  readonly LOAD_CANCELLED: { readonly slot: string; readonly revision: string }
  readonly MISSING_AUTO_POLICY: { readonly contract: string; readonly site: string; readonly families: readonly string[] }
  readonly MISSING_BINDING:
    | { readonly binding: string; readonly site: string; readonly missing: readonly string[] }
    | EntryParametersMissing
  readonly MISSING_IMPLEMENTATION:
    | { readonly binding: string; readonly implementation: string; readonly version: string; readonly available: readonly string[] }
    | { readonly contract: string; readonly site: string }
    | { readonly contract: string; readonly implementation: string; readonly version: string; readonly available?: readonly string[] }
    | { readonly revision: string | undefined }
  readonly MISSING_INPUT:
    | { readonly input: string; readonly site: string; readonly missing: readonly string[] }
    | EntryParametersMissing
  readonly MISSING_SERVICE:
    | { readonly revision: string }
    | { readonly binding: string; readonly revision: string }
    | { readonly revision: string; readonly site: string; readonly realm: string }
    | { readonly family: string; readonly range: string; readonly site: string; readonly realm: string }
  readonly OWNER_NOT_READY: { readonly entry: string; readonly env: string; readonly state: EnvState }
  readonly PLANNING_BUDGET_EXCEEDED: { readonly site: string; readonly budget: number }
  readonly ROLLBACK_FAILED: { readonly slot: string; readonly revision: string; readonly state: string }
  readonly RUNTIME_CLOSED: Record<string, never>
  readonly RUNTIME_MISMATCH: Record<string, never>
  readonly SHARE_CONSTRAINT_FAILED: { readonly revision: string; readonly env: string; readonly cause: ForkCause | undefined; readonly path: readonly string[] }
  /** `load()` on a slot that is closing, closed or abandoned; `state` is the slot's. */
  readonly SLOT_NOT_LOADABLE: { readonly slot: string; readonly revision: string; readonly state: 'disposing' | 'disposed' | 'abandoned' }
  readonly UNSATISFIABLE_TOPOLOGY: {
    readonly site: string
    readonly candidates: readonly string[]
    readonly failures: readonly { readonly code: SynaErrorCode; readonly message: string; readonly details: Readonly<Record<string, unknown>> }[]
  }
  readonly UNSETTLED_ATTEMPT:
    | { readonly attempts: readonly UnsettledAttemptInspection[] }
    | { readonly env: string; readonly state: EnvState; readonly slots: readonly AbandonedSlot[] }
    | { readonly slot: string; readonly revision: string; readonly attempt: number; readonly runningForMs: number }
}

/** A SynaError of one code: `details` has that code's shape. */
export interface SynaErrorOf<Code extends SynaErrorCode> extends Error {
  readonly name: 'SynaError'
  readonly code: Code
  readonly details: Readonly<SynaErrorDetails[Code]>
}

/**
 * Every error the Runtime throws or rejects with: a union discriminated by
 * `code`. `SynaError<'MISSING_INPUT'>` is one member; `isSynaError(error, code)`
 * and `error.code === code` narrow to it.
 */
export type SynaError<Code extends SynaErrorCode = SynaErrorCode> = Code extends SynaErrorCode ? SynaErrorOf<Code> : never

type DetailsArguments<Code extends SynaErrorCode> = {} extends SynaErrorDetails[Code]
  ? [details?: SynaErrorDetails[Code], options?: ErrorOptions]
  : [details: SynaErrorDetails[Code], options?: ErrorOptions]

export interface SynaErrorConstructor {
  new <Code extends SynaErrorCode>(code: Code, message: string, ...rest: DetailsArguments<Code>): SynaError<Code>
  readonly prototype: SynaError
}

class SynaErrorImpl<Code extends SynaErrorCode> extends Error {
  readonly code: Code
  readonly details: Readonly<SynaErrorDetails[Code]>

  constructor(code: Code, message: string, details?: SynaErrorDetails[Code], options?: ErrorOptions) {
    super(message, options)
    this.name = 'SynaError'
    this.code = code
    this.details = Object.freeze({ ...(details ?? {}) }) as Readonly<SynaErrorDetails[Code]>
  }
}

export const SynaError: SynaErrorConstructor = SynaErrorImpl as unknown as SynaErrorConstructor

export function isSynaError<Code extends SynaErrorCode = SynaErrorCode>(error: unknown, code?: Code): error is SynaError<Code> {
  return error instanceof SynaError && (code === undefined || error.code === code)
}

export function asSynaError<Code extends SynaErrorCode>(
  error: unknown,
  code: Code,
  message: string,
  ...rest: DetailsArguments<Code>
): SynaError {
  if (error instanceof SynaError) return error
  const [details, options] = rest
  return new SynaErrorImpl(code, message, details, {
    ...options,
    cause: error instanceof Error ? error : undefined,
  }) as unknown as SynaError<Code>
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

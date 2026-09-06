import type { SynaErrorCode } from '../errors.js'
import { SynaError } from '../errors.js'

const BACKTRACKABLE_CODES: ReadonlySet<SynaErrorCode> = new Set([
  'AMBIGUOUS_IMPLEMENTATION',
  'FRESH_CONSTRAINT_FAILED',
  'INCOMPATIBLE_IMPLEMENTATION',
  'LINEAGE_UNIQUENESS_CONFLICT',
  'MISSING_AUTO_POLICY',
  'MISSING_BINDING',
  'MISSING_IMPLEMENTATION',
  'MISSING_INPUT',
  'MISSING_SERVICE',
  'SHARE_CONSTRAINT_FAILED',
  'UNSATISFIABLE_TOPOLOGY',
])

/**
 * Only topology-unsatisfied errors may drive deterministic candidate
 * backtracking. Policy TypeErrors, invalid descriptors, budget exhaustion and
 * internal bugs propagate unchanged.
 */
export function isBacktrackableTopologyError(error: unknown): error is SynaError {
  return error instanceof SynaError && BACKTRACKABLE_CODES.has(error.code)
}

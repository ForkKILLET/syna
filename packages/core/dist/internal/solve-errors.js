import { SynaError } from '../errors.js';
const BACKTRACKABLE_CODES = new Set([
    'AMBIGUOUS_IMPLEMENTATION',
    'CONSTRAINT_VIOLATION',
    'INCOMPATIBLE_IMPLEMENTATION',
    'LINEAGE_UNIQUENESS_CONFLICT',
    'MISSING_AUTO_POLICY',
    'MISSING_BINDING',
    'MISSING_IMPLEMENTATION',
    'MISSING_INPUT',
    'MISSING_SERVICE',
    'SHARE_CONSTRAINT_FAILED',
    'UNSATISFIABLE_TOPOLOGY',
]);
/** Only topology-unsatisfied errors may drive deterministic candidate backtracking. */
export function isBacktrackableTopologyError(error) {
    return error instanceof SynaError && BACKTRACKABLE_CODES.has(error.code);
}
//# sourceMappingURL=solve-errors.js.map
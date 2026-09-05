import { SynaError } from '../errors.js';
/** Only topology-unsatisfied errors may drive deterministic candidate backtracking. */
export declare function isBacktrackableTopologyError(error: unknown): error is SynaError;
//# sourceMappingURL=solve-errors.d.ts.map
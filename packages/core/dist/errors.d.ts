export type SynaErrorCode = 'AMBIGUOUS_IMPLEMENTATION' | 'MISSING_AUTO_POLICY' | 'CIRCULAR_MATERIALIZATION' | 'CONSTRAINT_VIOLATION' | 'DUPLICATE_DEFINITION' | 'ENTRY_ACTIVATION_FAILED' | 'INCOMPATIBLE_IMPLEMENTATION' | 'INVALID_DESCRIPTOR' | 'INVALID_ENV_STATE' | 'LINEAGE_UNIQUENESS_CONFLICT' | 'MISSING_BINDING' | 'MISSING_IMPLEMENTATION' | 'MISSING_SERVICE' | 'MISSING_INPUT' | 'RUNTIME_MISMATCH' | 'SHARE_CONSTRAINT_FAILED' | 'UNAVAILABLE_IMPLEMENTATION' | 'UNSATISFIABLE_TOPOLOGY';
export type DiagnosticCode = SynaErrorCode | 'UNKNOWN_ERROR';
export declare class SynaError extends Error {
    readonly code: SynaErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    constructor(code: SynaErrorCode, message: string, details?: Readonly<Record<string, unknown>>, options?: ErrorOptions);
}
export declare function asSynaError(error: unknown, code: SynaErrorCode, message: string, details?: Readonly<Record<string, unknown>>): SynaError;
export declare function diagnosticFromError(error: unknown): Readonly<{
    code: SynaErrorCode | 'UNKNOWN_ERROR';
    message: string;
    details: Readonly<Record<string, unknown>>;
}>;
//# sourceMappingURL=errors.d.ts.map
export class SynaError extends Error {
    code;
    details;
    constructor(code, message, details = {}, options) {
        super(message, options);
        this.name = 'SynaError';
        this.code = code;
        this.details = Object.freeze({ ...details });
    }
}
export function asSynaError(error, code, message, details = {}) {
    if (error instanceof SynaError)
        return error;
    return new SynaError(code, message, details, {
        cause: error instanceof Error ? error : undefined,
    });
}
export function diagnosticFromError(error) {
    if (error instanceof SynaError) {
        return Object.freeze({ code: error.code, message: error.message, details: error.details });
    }
    return Object.freeze({
        code: 'UNKNOWN_ERROR',
        message: error instanceof Error ? error.message : String(error),
        details: Object.freeze({}),
    });
}
//# sourceMappingURL=errors.js.map
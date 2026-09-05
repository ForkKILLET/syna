export interface PostgresOptions {
    readonly connectionString: string;
    readonly applicationName?: string;
}
export declare const PostgresConfig: import("@syna/core").Input<PostgresOptions>;
export interface Postgres {
    readonly poolId: number;
    readonly connectionString: string;
    query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<readonly T[]>;
    stats(): Promise<{
        readonly queryCount: number;
    }>;
}
export declare const Postgres: import("@syna/core").ServiceRevision<Postgres>;
//# sourceMappingURL=index.d.ts.map
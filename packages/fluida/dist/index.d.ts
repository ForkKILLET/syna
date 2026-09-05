import { Postgres } from '@syna-demo/postgres';
export interface TransactionContext {
    readonly id: string;
    readonly mode: 'read' | 'write';
}
export declare const CurrentTransaction: import("@syna/core").Input<TransactionContext>;
export interface Transaction {
    readonly id: string;
    readonly mode: 'read' | 'write';
    readonly databasePool: number;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    readonly state: 'open' | 'committed' | 'rolled-back';
}
export declare const Transaction: import("@syna/core").ServiceRevision<Transaction>;
export interface ArticleRepository {
    find(id: string): Promise<{
        readonly id: string;
        readonly pool: number;
    }>;
}
export declare const ArticleRepository: import("@syna/core").ServiceRevision<ArticleRepository>;
export declare const DatabaseEntry: import("@syna/core").EntryDescriptor<{
    readonly database: import("@syna/core").ServiceRevision<Postgres>;
}, {
    readonly config: import("@syna/core").Input<import("@syna-demo/postgres").PostgresOptions>;
}>;
export declare const TransactionEntry: import("@syna/core").EntryDescriptor<{
    readonly transaction: import("@syna/core").ServiceRevision<Transaction>;
    readonly articles: import("@syna/core").ServiceRevision<ArticleRepository>;
}, {
    readonly transaction: import("@syna/core").Input<TransactionContext>;
}>;
//# sourceMappingURL=index.d.ts.map
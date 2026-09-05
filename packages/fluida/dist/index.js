import { Postgres, PostgresConfig } from '@syna-demo/postgres';
import { define } from './syna.js';
export const CurrentTransaction = define.input('current-transaction', { metadata: { displayName: 'Current transaction' } });
export const Transaction = define.service('transaction', {
    requires: {
        database: Postgres,
        context: CurrentTransaction,
    },
    async setup({ database, context }, { onDispose }) {
        const db = await database.load();
        const tx = await context.load();
        let state = 'open';
        onDispose(() => {
            if (state === 'open')
                state = 'rolled-back';
        });
        return {
            id: tx.id,
            mode: tx.mode,
            databasePool: db.poolId,
            async commit() {
                if (state !== 'open')
                    throw new Error(`Transaction ${tx.id} is ${state}.`);
                state = 'committed';
            },
            async rollback() {
                if (state !== 'open')
                    throw new Error(`Transaction ${tx.id} is ${state}.`);
                state = 'rolled-back';
            },
            get state() {
                return state;
            },
        };
    },
});
export const ArticleRepository = define.service('article-repository', {
    requires: {
        transaction: Transaction,
    },
    setup({ transaction }) {
        return {
            async find(id) {
                const tx = await transaction.load();
                return { id, pool: tx.databasePool };
            },
        };
    },
});
export const DatabaseEntry = define.entry('database', {
    requires: {
        database: Postgres,
    },
    parameters: {
        config: PostgresConfig,
    },
});
export const TransactionEntry = define.entry('transaction', {
    requires: {
        transaction: Transaction,
        articles: ArticleRepository,
    },
    parameters: {
        transaction: CurrentTransaction,
    },
});
//# sourceMappingURL=index.js.map
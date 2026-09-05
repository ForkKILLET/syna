import { Logger } from '@syna-demo/logger';
import { define } from './syna.js';
export const PostgresConfig = define.input('config', {
    metadata: {
        displayName: 'PostgreSQL configuration',
    },
});
const Metrics = define.service('pool-metrics', {
    setup() {
        let queryCount = 0;
        return {
            recordQuery() {
                queryCount += 1;
            },
            get queryCount() {
                return queryCount;
            },
        };
    },
});
let nextPoolId = 1;
export const Postgres = define.service({
    metadata: {
        displayName: 'PostgreSQL',
        description: 'A lifecycle-managed PostgreSQL-style connection pool.',
    },
    requires: {
        config: PostgresConfig,
        logger: Logger,
        metrics: Metrics,
    },
    async setup({ config, logger, metrics }, { onDispose }) {
        const options = await config.load();
        const log = await logger.load();
        const counters = await metrics.load();
        const poolId = nextPoolId++;
        let closed = false;
        log.info(`opening PostgreSQL pool #${poolId} for ${options.connectionString}`);
        onDispose(() => {
            closed = true;
            log.info(`closing PostgreSQL pool #${poolId}`);
        });
        return {
            poolId,
            connectionString: options.connectionString,
            async query(text, params = []) {
                if (closed)
                    throw new Error(`PostgreSQL pool #${poolId} is closed.`);
                counters.recordQuery();
                log.debug(`pool #${poolId}: ${text} ${JSON.stringify(params)}`);
                return [];
            },
            async stats() {
                return { queryCount: counters.queryCount };
            },
        };
    },
});
//# sourceMappingURL=index.js.map
import pg from 'pg';
import { config } from '../config.js';
import { log } from '../logger.js';

export const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
    // An idle client failed. The pool discards it; log so the cause is not silent.
    log.error(`pg pool error: ${err.message}`);
});

export interface DbStatus {
    reachable: boolean;
    version?: string;
    /** Null until the migrations have run. */
    claims?: number | null;
    /** Latest applied migration, or null before the first. */
    schema_version?: string | null;
    error?: string;
}

/**
 * Cheap reachability probe used by `/healthz` and the `owl_status` tool.
 *
 * The claim count is reported as null rather than an error when the schema has not been
 * migrated yet — before the worker's first start that is the expected state, not a fault.
 */
export async function dbStatus(): Promise<DbStatus> {
    try {
        const { rows } = await pool.query<{ version: string }>('SELECT version()');
        const version = rows[0]?.version?.split(' ').slice(0, 2).join(' ');

        let claims: number | null = null;
        const present = await pool.query<{ exists: boolean }>(
            "SELECT to_regclass('public.claims') IS NOT NULL AS exists",
        );
        if (present.rows[0]?.exists) {
            const counted = await pool.query<{ n: string }>('SELECT count(*) AS n FROM claims');
            claims = Number(counted.rows[0].n);
        }

        let schema_version: string | null = null;
        const migrated = await pool.query<{ exists: boolean }>(
            "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
        );
        if (migrated.rows[0]?.exists) {
            const latest = await pool.query<{ v: string | null }>('SELECT max(version) AS v FROM schema_migrations');
            schema_version = latest.rows[0].v;
        }

        return { reachable: true, version, claims, schema_version };
    } catch (err) {
        return { reachable: false, error: err instanceof Error ? err.message : String(err) };
    }
}

export async function closePool(): Promise<void> {
    await pool.end();
}

/**
 * Schema migrations: numbered SQL files in db/migrations, applied in order, each in its own
 * transaction, recorded with a checksum.
 *
 * Only the worker runs this, at startup, under a Postgres advisory lock. A rolling update
 * can briefly overlap an old and a new worker, and the lock is what keeps them from both
 * migrating. An applied migration whose file has since changed is a hard error: the fix is
 * a new migration, never an edit.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';
import { pool } from './pool.js';

/** Source tree, not dist/: tsc does not copy .sql, and the image ships both. */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

/** Arbitrary, but fixed: every OWL process must agree on it. */
const LOCK_KEY = 0x0_0517_0001;

export async function migrate(): Promise<string[]> {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    const client = await pool.connect();
    const applied: string[] = [];
    try {
        await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version    text PRIMARY KEY,
                checksum   text NOT NULL,
                applied_at timestamptz NOT NULL DEFAULT now()
            )`);
        const { rows } = await client.query<{ version: string; checksum: string }>(
            'SELECT version, checksum FROM schema_migrations',
        );
        const done = new Map(rows.map((r) => [r.version, r.checksum]));

        for (const file of files) {
            const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
            const checksum = createHash('sha256').update(sql).digest('hex');
            const version = file.replace(/\.sql$/, '');
            const previous = done.get(version);
            if (previous) {
                if (previous !== checksum) {
                    throw new Error(`migration ${file} was changed after it was applied`);
                }
                continue;
            }
            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query(
                    'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
                    [version, checksum],
                );
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : err}`);
            }
            log.info(`migration applied: ${version}`);
            applied.push(version);
        }
        await checkEmbeddingDimensions(client);
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
        client.release();
    }
    return applied;
}

/**
 * The column type fixes the dimension; a config that disagrees would fail on the first
 * insert, long after startup. Fail now instead.
 */
async function checkEmbeddingDimensions(client: import('pg').PoolClient): Promise<void> {
    const { rows } = await client.query<{ dims: number }>(`
        SELECT atttypmod AS dims FROM pg_attribute
        WHERE attrelid = 'claims'::regclass AND attname = 'embedding'`);
    const dims = rows[0]?.dims;
    if (dims !== config.embedding.dimensions) {
        throw new Error(
            `claims.embedding is ${dims}-dimensional but OWL_EMBEDDING_DIMENSIONS=` +
            `${config.embedding.dimensions}; re-embed instead of changing the config`,
        );
    }
}

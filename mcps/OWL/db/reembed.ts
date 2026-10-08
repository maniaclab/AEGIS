#!/usr/bin/env node
/**
 * Rebuild every claim embedding with a new model or dimension.
 *
 *   npm run reembed -- --model text-embedding-3-large --dimensions 1536 [--batch 256]
 *
 * Fills a shadow column, then swaps it in one transaction, so search keeps working on the
 * old embeddings until the new ones are complete. Resumable: an interrupted run keeps the
 * shadow column and continues where it stopped.
 *
 * Afterwards set OWL_EMBEDDING_MODEL and OWL_EMBEDDING_DIMENSIONS to the new values before
 * the worker restarts — it refuses to start while they disagree with the column. Stop
 * submissions while this runs: claims added meanwhile get a shadow embedding only if they
 * arrive before the swap, and are re-embedded by running it again otherwise.
 */
import { parseArgs } from 'node:util';
import { config } from '../config.js';
import { log } from '../logger.js';
import { embed, toVectorLiteral } from '../llm/provider.js';
import { closePool, pool } from './pool.js';

const { values: args } = parseArgs({
    options: {
        model: { type: 'string', default: config.embedding.model },
        dimensions: { type: 'string', default: String(config.embedding.dimensions) },
        batch: { type: 'string', default: '256' },
    },
});

async function main(): Promise<void> {
    const model = args.model!;
    const dims = Number(args.dimensions);
    const batch = Number(args.batch);
    if (!Number.isInteger(dims) || dims < 1 || dims > 4000) {
        throw new Error('--dimensions must be 1..4000 (the HNSW limit for halfvec)');
    }

    await pool.query(`ALTER TABLE claims ADD COLUMN IF NOT EXISTS embedding_next halfvec(${dims})`);
    const { rows: [col] } = await pool.query<{ dims: number }>(`
        SELECT atttypmod AS dims FROM pg_attribute
        WHERE attrelid = 'claims'::regclass AND attname = 'embedding_next'`);
    if (col.dims !== dims) {
        throw new Error(`an unfinished re-embed to ${col.dims} dimensions exists; finish it or drop claims.embedding_next`);
    }

    let done = 0;
    for (;;) {
        const { rows } = await pool.query<{ id: string; text: string }>(`
            SELECT id, text FROM claims WHERE embedding_next IS NULL ORDER BY id LIMIT $1`, [batch]);
        if (!rows.length) break;
        const vectors = await embed(rows.map((r) => r.text), { model, dimensions: dims });
        for (const [i, r] of rows.entries()) {
            await pool.query('UPDATE claims SET embedding_next = $2::halfvec WHERE id = $1', [r.id, toVectorLiteral(vectors[i])]);
        }
        done += rows.length;
        log.info(`reembed: ${done} claims`);
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE claims IN ACCESS EXCLUSIVE MODE');
        const { rows: [left] } = await client.query<{ n: string }>('SELECT count(*) AS n FROM claims WHERE embedding_next IS NULL');
        if (Number(left.n)) throw new Error(`${left.n} claims arrived during the run; run again`);
        await client.query('DROP INDEX IF EXISTS claims_embedding_hnsw');
        await client.query('ALTER TABLE claims DROP COLUMN embedding');
        await client.query('ALTER TABLE claims RENAME COLUMN embedding_next TO embedding');
        await client.query('UPDATE claims SET embedding_model = $1', [model]);
        await client.query('CREATE INDEX claims_embedding_hnsw ON claims USING hnsw (embedding halfvec_cosine_ops)');
        await client.query(
            `INSERT INTO audit_log (identity_id, action, target_kind, detail) VALUES ('owl:reembed', 'claims.reembed', 'claims', $1)`,
            [JSON.stringify({ model, dimensions: dims, claims: done })]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
    log.info(`reembed: swapped in ${model}/${dims}d for ${done} claims. ` +
        `Now set OWL_EMBEDDING_MODEL=${model} OWL_EMBEDDING_DIMENSIONS=${dims} and restart both deployments.`);
}

main()
    .catch((err) => {
        log.error(`reembed failed: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
    })
    .finally(() => closePool());

/**
 * The job queue, on the same Postgres: `SELECT ... FOR UPDATE SKIP LOCKED`, no broker.
 *
 * A job is keyed by its idempotency key, so submitting the same thing twice returns the
 * first job instead of doing the work again. A job that ended without committing
 * (expired, rejected, failed) can be resubmitted, which re-arms it.
 */
import { pool } from './pool.js';
import { config } from '../config.js';

export type JobState = 'queued' | 'running' | 'awaiting_confirmation' | 'done' | 'failed' | 'expired' | 'rejected';

export interface Job<P = unknown, R = unknown> {
    id: string;
    idempotency_key: string;
    kind: string;
    state: JobState;
    attempts: number;
    payload: P;
    result: R | null;
    error: string | null;
    submitted_by: string | null;
    document_id: string | null;
    expires_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

const MAX_ATTEMPTS = 3;

export interface NewJob {
    key: string;
    kind: string;
    state: 'queued' | 'awaiting_confirmation';
    payload: unknown;
    submittedBy: string;
    result?: unknown;
    expiresAt?: Date;
}

/** Insert, or return the existing job for the same key. `created` says which. */
export async function createJob<P, R>(j: NewJob): Promise<{ job: Job<P, R>; created: boolean }> {
    const { rows } = await pool.query<Job<P, R>>(`
        INSERT INTO jobs (idempotency_key, kind, state, payload, result, submitted_by, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (idempotency_key) DO UPDATE SET
            state = EXCLUDED.state, payload = EXCLUDED.payload, result = EXCLUDED.result,
            error = NULL, attempts = 0, expires_at = EXCLUDED.expires_at,
            run_after = now(), updated_at = now()
        WHERE jobs.state IN ('expired', 'rejected', 'failed')
        RETURNING *`, [
        j.key, j.kind, j.state, JSON.stringify(j.payload),
        j.result === undefined ? null : JSON.stringify(j.result), j.submittedBy, j.expiresAt ?? null,
    ]);
    if (rows[0]) return { job: rows[0], created: true };
    const existing = await pool.query<Job<P, R>>('SELECT * FROM jobs WHERE idempotency_key = $1', [j.key]);
    return { job: existing.rows[0], created: false };
}

export async function getJob<P, R>(id: string): Promise<Job<P, R> | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await pool.query<Job<P, R>>('SELECT * FROM jobs WHERE id = $1', [id]);
    return rows[0] ?? null;
}

/** Take the oldest runnable job, or null. Safe with any number of concurrent workers. */
export async function claimNext<P, R>(): Promise<Job<P, R> | null> {
    const { rows } = await pool.query<Job<P, R>>(`
        UPDATE jobs SET state = 'running', attempts = attempts + 1, updated_at = now()
        WHERE id = (
            SELECT id FROM jobs WHERE state = 'queued' AND run_after <= now()
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING *`);
    return rows[0] ?? null;
}

export async function finishJob(id: string, state: JobState, result: unknown, documentId?: string | null): Promise<void> {
    await pool.query(`
        UPDATE jobs SET state = $2, result = $3, document_id = coalesce($4, document_id),
                        error = NULL, expires_at = NULL, updated_at = now()
        WHERE id = $1`, [id, state, JSON.stringify(result), documentId ?? null]);
}

/** Retry with exponential backoff, or give up after MAX_ATTEMPTS. Returns the new state. */
export async function failJob(job: Job, error: string): Promise<JobState> {
    const state: JobState = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
    await pool.query(`
        UPDATE jobs SET state = $2, error = $3,
               run_after = now() + make_interval(mins => power(2, attempts)::int), updated_at = now()
        WHERE id = $1`, [job.id, state, error.slice(0, 2000)]);
    return state;
}

/** Worker startup: anything left `running` belonged to a worker that died. */
export async function requeueOrphans(): Promise<number> {
    const { rowCount } = await pool.query(`UPDATE jobs SET state = 'queued', updated_at = now() WHERE state = 'running'`);
    return rowCount ?? 0;
}

export async function expireAwaiting(): Promise<number> {
    const { rowCount } = await pool.query(`
        UPDATE jobs SET state = 'expired', updated_at = now()
        WHERE state = 'awaiting_confirmation' AND expires_at < now()`);
    return rowCount ?? 0;
}

/**
 * Submissions in the last hour against the per-identity limit; throws when over it.
 * Counted in the database, so the limit holds across replicas and restarts.
 */
export async function checkRateLimit(identityId: string, trusted: boolean): Promise<void> {
    const limit = config.rateLimitPerHour * (trusted ? 10 : 1);
    const { rows } = await pool.query<{ n: string }>(`
        SELECT count(*) AS n FROM jobs WHERE submitted_by = $1 AND created_at > now() - interval '1 hour'`,
        [identityId]);
    if (Number(rows[0].n) >= limit) {
        throw new Error(`rate limit: ${limit} submissions per hour; try again later`);
    }
}

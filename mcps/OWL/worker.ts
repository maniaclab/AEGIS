#!/usr/bin/env node
/**
 * owl-worker — the write-side process.
 *
 * Single replica: it owns schema migrations, drains the ingest queue, and runs the
 * scheduled sweeps (TTL re-verification, dispute escalation, weekly digests). Running two
 * of these would duplicate every sweep, so the deployment pins it to one.
 *
 * It migrates, then drains the ingest queue; the scheduled sweeps arrive with Phase 3+.
 * It also verifies at startup that everything the pipeline will depend on is actually reachable,
 * because a silent failure here — an unreachable Spark, say — would later stall the whole
 * ingest queue with no obvious cause.
 */
import { config } from './config.js';
import { log, logUpstream } from './logger.js';
import { closePool, dbStatus } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { claimNext, expireAwaiting, failJob, finishJob, Job, requeueOrphans } from './db/jobs.js';
import { DocumentPayload, runDocumentJob } from './pipeline/run.js';

// @ts-expect-error ignore `with` keyword
import pkg from './package.json' with { type: 'json' }

const HEARTBEAT_MS = Number(process.env.OWL_HEARTBEAT_MS ?? 300_000);
const POLL_MS = Number(process.env.OWL_JOB_POLL_MS ?? 2_000);

let stopping = false;

/** One job at a time: extraction is bound by the model, and order is easier to reason about. */
async function drain(): Promise<void> {
    while (!stopping) {
        let job: Job<DocumentPayload> | null = null;
        try {
            job = await claimNext<DocumentPayload, unknown>();
            if (!job) {
                await new Promise((r) => setTimeout(r, POLL_MS));
                continue;
            }
            if (job.kind !== 'submit_document') throw new Error(`unknown job kind '${job.kind}'`);
            const started = Date.now();
            const result = await runDocumentJob(job);
            await finishJob(job.id, 'done', result, job.payload.source.hash);
            log.info(`job ${job.id} done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${result.summary}`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (job) {
                const state = await failJob(job, message).catch(() => 'unknown');
                log.error(`job ${job.id} attempt ${job.attempts} failed (now ${state}): ${message}`);
            } else {
                log.error(`queue: ${message}`);
                await new Promise((r) => setTimeout(r, POLL_MS * 5));
            }
        }
    }
}

/** Confirm the cheap-path vLLM endpoint answers and serves the configured model. */
async function checkCheapModel(): Promise<void> {
    if (!config.cheap.baseUrl) {
        log.warn('OWL_CHEAP_BASE_URL is not set — extraction will have no cheap model');
        return;
    }
    const url = `${config.cheap.baseUrl.replace(/\/$/, '')}/models`;
    const started = process.hrtime.bigint();
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        logUpstream('vllm', 'GET', '/models', res.status, started);
        if (!res.ok) {
            log.error(`cheap model endpoint ${url} returned ${res.status}`);
            return;
        }
        const body = await res.json() as { data?: { id?: string }[] };
        const served = (body.data ?? []).map((m) => m.id).filter(Boolean);
        if (!served.includes(config.cheap.model)) {
            log.warn(
                `cheap model '${config.cheap.model}' not served by ${url} ` +
                `(available: ${served.join(', ') || 'none'})`,
            );
        } else {
            log.info(`cheap model '${config.cheap.model}' available at ${config.cheap.baseUrl}`);
        }
    } catch (err) {
        log.error(`cheap model endpoint ${url} unreachable: ${err}`);
    }
}

async function main(): Promise<void> {
    log.info(`OWL worker ${pkg.version} starting`);

    const db = await dbStatus();
    if (!db.reachable) {
        log.error(`database unreachable: ${db.error}`);
        process.exit(1);
    }
    log.info(`database ok: ${db.version}`);

    const applied = await migrate();
    const after = await dbStatus();
    log.info(
        `schema ${after.schema_version} (${applied.length ? `applied ${applied.join(', ')}` : 'up to date'}), ` +
        `claims=${after.claims}`,
    );

    await checkCheapModel();

    if (!config.openaiApiKey) {
        log.warn('OPENAI_API_KEY is not set — adjudication and embeddings will fail');
    }

    const orphans = await requeueOrphans();
    if (orphans) log.warn(`requeued ${orphans} job(s) left running by a previous worker`);
    const draining = drain();
    log.info('draining the ingest queue');

    const heartbeat = setInterval(() => {
        void expireAwaiting().then((n) => n && log.info(`expired ${n} unconfirmed submission(s)`)).catch(() => undefined);
        void dbStatus().then((s) =>
            s.reachable
                ? log.debug(`heartbeat: db ok, claims=${s.claims ?? 'n/a'}`)
                : log.error(`heartbeat: database unreachable: ${s.error}`),
        );
    }, HEARTBEAT_MS);

    const shutdown = async (signal: string): Promise<void> => {
        log.info(`${signal} received, shutting down...`);
        stopping = true;
        clearInterval(heartbeat);
        // Let the job in hand finish; requeueOrphans() picks it up next start if it does not.
        await Promise.race([draining, new Promise((r) => setTimeout(r, 20_000))]);
        await closePool();
        process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
    log.error(`worker failed to start: ${err}`);
    process.exit(1);
});

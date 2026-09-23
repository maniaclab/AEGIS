#!/usr/bin/env node
/**
 * owl-worker — the write-side process.
 *
 * Single replica: it owns schema migrations, drains the ingest queue, and runs the
 * scheduled sweeps (TTL re-verification, dispute escalation, weekly digests). Running two
 * of these would duplicate every sweep, so the deployment pins it to one.
 *
 * Phase 0 does none of that work yet. What it does do is verify at startup that everything
 * the pipeline will depend on is actually reachable, because a silent failure here — an
 * unreachable Spark, say — would later stall the whole ingest queue with no obvious cause.
 */
import { config } from './config.js';
import { log, logUpstream } from './logger.js';
import { closePool, dbStatus } from './db/pool.js';

// @ts-expect-error ignore `with` keyword
import pkg from './package.json' with { type: 'json' }

const HEARTBEAT_MS = Number(process.env.OWL_HEARTBEAT_MS ?? 300_000);

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
    log.info(`database ok: ${db.version}, claims=${db.claims ?? '(schema not migrated)'}`);

    await checkCheapModel();

    if (!config.openaiApiKey) {
        log.warn('OPENAI_API_KEY is not set — adjudication and embeddings will fail');
    }

    // Phase 1 runs migrations here, Phase 2 starts the queue drain, Phase 3+ the sweeps.
    log.info('no work to do yet (Phase 0) — idling');

    const heartbeat = setInterval(() => {
        void dbStatus().then((s) =>
            s.reachable
                ? log.debug(`heartbeat: db ok, claims=${s.claims ?? 'n/a'}`)
                : log.error(`heartbeat: database unreachable: ${s.error}`),
        );
    }, HEARTBEAT_MS);

    const shutdown = async (signal: string): Promise<void> => {
        log.info(`${signal} received, shutting down...`);
        clearInterval(heartbeat);
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

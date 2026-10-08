#!/usr/bin/env node
/**
 * Re-run extraction over stored originals with the current prompts, and diff.
 *
 *   npm run reextract -- [--since 2026-10-01] [--document <hash>] [--all] [--commit]
 *
 * By default it replays documents whose claims came from an older prompt or novelty
 * version (`--all` replays every document with a stored original). For each it prints:
 *
 *   kept     — candidates that duplicate a claim already cited from this document
 *   added    — candidates not in the store (or only cited from other documents)
 *   missing  — claims cited from this document that the new extraction no longer finds
 *
 * Nothing is written without --commit. With it, added claims are committed as
 * quarantined (a replay is not a person vouching for them), duplicates gain a citation
 * under the new extractor version, and missing claims are only reported — never retired
 * automatically: a prompt that stops finding something is as likely to be the regression.
 */
import { parseArgs } from 'node:util';
import { log } from '../logger.js';
import { closePool, pool } from './pool.js';
import { analyze, Source } from '../pipeline/ingest.js';
import { getBlob } from '../pipeline/blob.js';
import { commit } from '../pipeline/commit.js';
import { PROMPT_VERSION } from '../pipeline/extract.js';
import { NOVELTY_VERSION } from '../pipeline/novelty.js';

const { values: args } = parseArgs({
    options: {
        since: { type: 'string' },
        document: { type: 'string' },
        all: { type: 'boolean', default: false },
        commit: { type: 'boolean', default: false },
    },
});

const CURRENT = `${PROMPT_VERSION}+${NOVELTY_VERSION}/`;

interface Doc {
    content_hash: string; uri: string; title: string | null; source_kind: string;
    media_type: string; blob_ref: string; extractors: string[];
}

async function main(): Promise<void> {
    const { rows: docs } = await pool.query<Doc>(`
        SELECT d.content_hash, d.uri, d.title, d.source_kind, d.media_type, d.blob_ref,
               array_agg(DISTINCT p.extractor_version) AS extractors
        FROM documents d JOIN claim_provenance p ON p.document_id = d.content_hash
        WHERE d.blob_ref IS NOT NULL AND d.media_type IS NOT NULL
          AND ($1::timestamptz IS NULL OR d.fetched_at >= $1)
          AND ($2::text IS NULL OR d.content_hash = $2)
        GROUP BY d.content_hash
        ORDER BY d.fetched_at`, [args.since ?? null, args.document ?? null]);
    const todo = args.all || args.document ? docs : docs.filter((d) => !d.extractors.some((e) => e.startsWith(CURRENT)));
    log.info(`reextract: ${todo.length} of ${docs.length} documents to replay with ${CURRENT}`);

    for (const d of todo) {
        const raw = await getBlob(d.blob_ref);
        const source: Source = {
            raw, mediaType: d.media_type, sourceKind: d.source_kind, uri: d.uri, title: d.title,
            hash: d.content_hash, blobRef: d.blob_ref,
        };
        const { analysis, vectors } = await analyze(source);
        const { rows: cited } = await pool.query<{ id: string; text: string }>(`
            SELECT DISTINCT c.id, c.text FROM claims c JOIN claim_provenance p ON p.claim_id = c.id
            WHERE p.document_id = $1 AND c.status <> 'retired'`, [d.content_hash]);
        const citedIds = new Set(cited.map((c) => c.id));

        const kept = analysis.claims.filter((c) => c.verdict === 'duplicate' && c.neighbour && citedIds.has(c.neighbour.id));
        const added = analysis.claims.filter((c) => !kept.includes(c));
        const found = new Set(kept.map((c) => c.neighbour!.id));
        const missing = cited.filter((c) => !found.has(c.id));

        console.log(`\n== ${d.title ?? d.uri} (${d.content_hash.slice(0, 12)}; was ${d.extractors.join(', ')})`);
        console.log(`   kept ${kept.length}, added ${added.length}, missing ${missing.length}, dropped ${analysis.dropped.length}`);
        for (const c of added) console.log(`   + [${c.verdict}] ${c.text}`);
        for (const c of missing) console.log(`   - ${c.text}`);

        if (args.commit) {
            const r = await commit(analysis, { id: 'owl:reextract', kind: 'service', trusted: false }, { vectors });
            console.log(`   committed: ${r.created.length} new (quarantined), ${r.attested.length} citations`);
        }
    }
    if (!args.commit && todo.length) console.log('\n(dry run: nothing written; add --commit to apply)');
}

main()
    .catch((err) => {
        log.error(`reextract failed: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
    })
    .finally(() => closePool());

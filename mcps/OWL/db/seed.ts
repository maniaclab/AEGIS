#!/usr/bin/env node
/**
 * Load hand-curated seed claims into OWL.
 *
 *   npm run seed -- --repo ../../../aegis-agents [--file owl/seed-claims.yaml]
 *                   [--owner ivukotic] [--no-edges] [--dry-run]
 *
 * The seed file lives in the private aegis-agents repo. Every claim quotes its source
 * verbatim; the source is read with `git show <commit>:<path>`, so provenance points at an
 * exact, immutable revision and the span offsets are computed rather than typed. A quote
 * that is missing, or appears more than once, aborts the load.
 *
 * Idempotent: claims are keyed by `seed:<id>`, so re-running updates in place. A seed
 * claim that has disappeared from the file is retired, not deleted. Reviewing and merging
 * the seed file is the trusted writer's confirmation, so claims load as `active`.
 *
 * `expect_edge: {type: supersedes, to: X}` inserts the edge and marks X superseded. With
 * --no-edges both claims stay active, which is the input Phase 3 conflict detection has
 * to get right on its own.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { config } from '../config.js';
import { log } from '../logger.js';
import { closePool, pool } from './pool.js';
import { migrate } from './migrate.js';
import { embed, embeddingsAvailable, toVectorLiteral } from '../llm/embeddings.js';

const EXTRACTOR = 'seed-v1';

interface SeedQuote { source: string; quote: string }
interface SeedClaim extends SeedQuote {
    id: string;
    subject: string;
    predicate?: string;
    text: string;
    also?: SeedQuote[];
    asserted_by?: string;
    valid_from?: string;
    valid_to?: string;
    ttl_days?: number;
    confidence?: number;
    expect_edge?: { type: string; to: string };
}
interface SeedFile {
    commit: string;
    documents: Record<string, string | { by: string; at: string; text: string }>;
    entities: { id: string; kind: string; name: string; aliases?: string[]; cric_ref?: string }[];
    claims: SeedClaim[];
}

interface LoadedDoc { key: string; hash: string; uri: string; title: string; kind: string; text: string; at: string | null }

const { values: args } = parseArgs({
    options: {
        repo: { type: 'string', default: process.env.OWL_SEED_REPO },
        file: { type: 'string', default: 'owl/seed-claims.yaml' },
        owner: { type: 'string', default: 'ivukotic' },
        'no-edges': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
    },
});

function git(repo: string, ...a: string[]): string {
    return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
}

/** Offsets in code points, so they agree with Postgres substring(). */
function locate(doc: LoadedDoc, quote: string, claimId: string): [number, number] {
    const i = doc.text.indexOf(quote);
    if (i < 0) throw new Error(`${claimId}: quote not found in ${doc.key}: ${quote}`);
    if (doc.text.indexOf(quote, i + 1) >= 0) throw new Error(`${claimId}: quote is not unique in ${doc.key}: ${quote}`);
    const start = [...doc.text.slice(0, i)].length;
    return [start, start + [...quote].length];
}

function loadDocuments(repo: string, seed: SeedFile): Map<string, LoadedDoc> {
    const origin = (() => {
        try { return git(repo, 'config', '--get', 'remote.origin.url').trim(); }
        catch { return path.basename(path.resolve(repo)); }
    })().replace(/^git@github\.com:/, 'github.com/').replace(/^https:\/\//, '').replace(/\.git$/, '');
    const docs = new Map<string, LoadedDoc>();
    for (const [key, src] of Object.entries(seed.documents)) {
        const doc = typeof src === 'string'
            ? {
                key,
                uri: `git:${origin}@${seed.commit}:${src}`,
                title: src,
                kind: /^agents\/[^/]+\/workspace\//.test(src) ? 'agent-memory' : 'git-file',
                text: git(repo, 'show', `${seed.commit}:${src}`),
                at: git(repo, 'show', '-s', '--format=%cI', seed.commit).trim(),
            }
            : {
                key,
                uri: `statement:${key}`,
                title: `Statement by ${src.by}`,
                kind: 'statement',
                text: src.text,
                at: String(src.at),
            };
        docs.set(key, { ...doc, hash: createHash('sha256').update(doc.text, 'utf8').digest('hex') });
    }
    return docs;
}

async function main(): Promise<void> {
    if (!args.repo) throw new Error('--repo (or OWL_SEED_REPO) is required: the aegis-agents checkout');
    const seed = YAML.parse(readFileSync(path.join(args.repo, args.file!), 'utf8')) as SeedFile;
    const docs = loadDocuments(args.repo, seed);
    const entityIds = new Set(seed.entities.map((e) => e.id));
    const claimIds = new Set(seed.claims.map((c) => c.id));

    // Validate everything before touching the database.
    const spans = new Map<string, { doc: LoadedDoc; span: [number, number]; quote: string; asserted_by?: string }[]>();
    for (const c of seed.claims) {
        if (!entityIds.has(c.subject)) throw new Error(`${c.id}: unknown entity '${c.subject}'`);
        if (c.expect_edge && !claimIds.has(c.expect_edge.to)) throw new Error(`${c.id}: edge to unknown claim '${c.expect_edge.to}'`);
        spans.set(c.id, [c, ...(c.also ?? [])].map((q) => {
            const doc = docs.get(q.source);
            if (!doc) throw new Error(`${c.id}: unknown document '${q.source}'`);
            return { doc, span: locate(doc, q.quote, c.id), quote: q.quote, asserted_by: c.asserted_by };
        }));
    }
    log.info(`seed: ${seed.claims.length} claims, ${seed.entities.length} entities, ${docs.size} documents validated`);
    if (args['dry-run']) return;

    await migrate();

    // Embed only what is new or whose text changed.
    const existing = new Map((await pool.query<{ external_id: string; text: string; has: boolean }>(
        "SELECT external_id, text, embedding IS NOT NULL AS has FROM claims WHERE external_id LIKE 'seed:%'",
    )).rows.map((r) => [r.external_id, r]));
    const toEmbed = seed.claims.filter((c) => {
        const e = existing.get(`seed:${c.id}`);
        return !e || !e.has || e.text !== c.text.trim();
    });
    const vectors = new Map<string, string>();
    if (toEmbed.length && embeddingsAvailable()) {
        const v = await embed(toEmbed.map((c) => c.text.trim()));
        toEmbed.forEach((c, i) => vectors.set(c.id, toVectorLiteral(v[i])));
    } else if (toEmbed.length) {
        log.warn(`seed: OPENAI_API_KEY not set — ${toEmbed.length} claims stored without embeddings`);
    }

    const client = await pool.connect();
    const owner = args.owner!;
    try {
        await client.query('BEGIN');
        const audit = (action: string, kind: string, id: string, detail?: unknown) => client.query(
            `INSERT INTO audit_log (identity_id, action, target_kind, target_id, detail)
             VALUES ($1, $2, $3, $4, $5)`, [owner, action, kind, id, detail ? JSON.stringify(detail) : null]);

        for (const e of seed.entities) {
            await client.query(`
                INSERT INTO entities (id, kind, name, cric_ref) VALUES ($1, $2, $3, $4)
                ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, name = EXCLUDED.name,
                                               cric_ref = EXCLUDED.cric_ref, provisional = false`,
                [e.id, e.kind, e.name, e.cric_ref ?? null]);
            await client.query('DELETE FROM entity_aliases WHERE entity_id = $1', [e.id]);
            const aliases = [...new Map([e.id, e.name, ...(e.aliases ?? [])].map((a) => [a.toLowerCase(), a])).values()];
            for (const a of aliases) {
                await client.query('INSERT INTO entity_aliases (entity_id, alias) VALUES ($1, $2)', [e.id, a]);
            }
        }

        for (const d of docs.values()) {
            await client.query(`
                INSERT INTO documents (content_hash, uri, title, source_kind, fetched_at, parser_version)
                VALUES ($1, $2, $3, $4, coalesce($5::timestamptz, now()), $6)
                ON CONFLICT (content_hash) DO NOTHING`,
                [d.hash, d.uri, d.title, d.kind, d.at, EXTRACTOR]);
        }

        const uuid = new Map<string, string>();
        for (const c of seed.claims) {
            const sources = spans.get(c.id)!;
            const { rows } = await client.query<{ id: string; inserted: boolean }>(`
                INSERT INTO claims (external_id, text, subject_entity_id, predicate, valid_from, valid_to,
                                    status, confidence, ttl_days, owner_identity, embedding, embedding_model)
                VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10::halfvec, $11)
                ON CONFLICT (external_id) DO UPDATE SET
                    text = EXCLUDED.text,
                    subject_entity_id = EXCLUDED.subject_entity_id,
                    predicate = EXCLUDED.predicate,
                    valid_from = EXCLUDED.valid_from,
                    valid_to = EXCLUDED.valid_to,
                    status = 'active',
                    retracted_at = NULL,
                    confidence = EXCLUDED.confidence,
                    ttl_days = EXCLUDED.ttl_days,
                    owner_identity = EXCLUDED.owner_identity,
                    embedding = CASE WHEN claims.text = EXCLUDED.text
                                     THEN coalesce(EXCLUDED.embedding, claims.embedding)
                                     ELSE EXCLUDED.embedding END,
                    embedding_model = CASE WHEN EXCLUDED.embedding IS NOT NULL THEN EXCLUDED.embedding_model
                                           WHEN claims.text = EXCLUDED.text THEN claims.embedding_model END,
                    updated_at = now()
                RETURNING id, (xmax = 0) AS inserted`, [
                `seed:${c.id}`,
                c.text.trim(),
                c.subject,
                c.predicate ?? null,
                c.valid_from ? String(c.valid_from) : null,
                c.valid_to ? String(c.valid_to) : null,
                c.confidence ?? Math.min(0.95, 0.8 + 0.05 * (sources.length - 1)),
                c.ttl_days ? c.ttl_days : null,
                owner,
                vectors.get(c.id) ?? null,
                vectors.has(c.id) ? config.embedding.model : null,
            ]);
            const id = rows[0].id;
            uuid.set(c.id, id);

            await client.query('DELETE FROM claim_provenance WHERE claim_id = $1 AND extractor_version = $2', [id, EXTRACTOR]);
            for (const s of sources) {
                await client.query(`
                    INSERT INTO claim_provenance (claim_id, document_id, span_start, span_end, span_text,
                                                  extractor_version, submitted_by, asserted_by)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [id, s.doc.hash, s.span[0], s.span[1], s.quote, EXTRACTOR, owner, s.asserted_by ?? null]);
            }
            await audit(rows[0].inserted ? 'claim.create' : 'claim.update', 'claim', id, { external_id: `seed:${c.id}`, via: EXTRACTOR });
        }

        // Edges from a previous seed run are rebuilt, so removing one from the file removes it here.
        await client.query(`
            DELETE FROM claim_edges WHERE created_by = $1
              AND from_claim IN (SELECT id FROM claims WHERE external_id LIKE 'seed:%')`, [`${owner} via ${EXTRACTOR}`]);
        let edges = 0;
        if (!args['no-edges']) {
            for (const c of seed.claims.filter((c) => c.expect_edge)) {
                const from = uuid.get(c.id)!;
                const to = uuid.get(c.expect_edge!.to)!;
                await client.query(`
                    INSERT INTO claim_edges (from_claim, to_claim, type, created_by) VALUES ($1, $2, $3, $4)`,
                    [from, to, c.expect_edge!.type, `${owner} via ${EXTRACTOR}`]);
                if (c.expect_edge!.type === 'supersedes') {
                    await client.query(`
                        UPDATE claims t SET status = 'superseded',
                               valid_to = coalesce(t.valid_to, s.valid_from, now()), updated_at = now()
                        FROM claims s WHERE t.id = $2 AND s.id = $1`, [from, to]);
                }
                await audit('edge.create', 'claim', from, { type: c.expect_edge!.type, to });
                edges++;
            }
        }

        const retired = await client.query<{ external_id: string }>(`
            UPDATE claims SET status = 'retired', retracted_at = now(), updated_at = now()
            WHERE external_id LIKE 'seed:%' AND NOT (external_id = ANY($1::text[])) AND status <> 'retired'
            RETURNING external_id`, [seed.claims.map((c) => `seed:${c.id}`)]);
        for (const r of retired.rows) await audit('claim.retire', 'claim', r.external_id, { reason: 'removed from seed file' });

        await client.query('COMMIT');
        log.info(
            `seed: loaded ${seed.claims.length} claims (${vectors.size} embedded), ${edges} edges` +
            `${retired.rowCount ? `, retired ${retired.rows.map((r) => r.external_id).join(', ')}` : ''}`,
        );
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

main()
    .catch((err) => {
        log.error(`seed failed: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
    })
    .finally(() => closePool());

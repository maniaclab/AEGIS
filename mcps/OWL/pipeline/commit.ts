/**
 * Commit an analysis: one transaction for the document, the entities, the claims, their
 * provenance and the audit trail.
 *
 * Status: a trusted writer's claims commit `active`; everyone else's land in
 * `quarantined` for a trusted writer to confirm. Agent memory is always quarantined,
 * whoever submits it: an agent wrote it, and agent-written knowledge is exactly what can
 * poison the store.
 *
 * A duplicate does not create a claim. It adds a citation to the existing one —
 * re-attestation by another source raises confidence — and a trusted writer
 * re-attesting a quarantined claim confirms it.
 */
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { embed, embeddingsAvailable, toVectorLiteral } from '../llm/provider.js';
import type { Analysis, AnalyzedClaim } from './ingest.js';
import { putBlob } from './blob.js';

export interface Committer {
    id: string;
    username?: string;
    kind: 'person' | 'service';
    trusted: boolean;
    tokenId?: string;
}

export interface CommitOptions {
    /** Indices to commit; default all. */
    accept?: number[];
    /** Replacement claim text by index; the quote and span are kept. */
    edits?: Record<number, string>;
    /** Embeddings computed during analysis, by index; anything missing or edited is re-embedded. */
    vectors?: Map<number, number[]>;
}

export interface CommitResult {
    status: 'active' | 'quarantined';
    created: { idx: number; id: string; text: string }[];
    attested: { idx: number; id: string; text: string; now: string }[];
    skipped: number[];
    entities_created: string[];
}

const ATTEST_STEP = 0.05;
const MAX_CONFIDENCE = 0.95;

export async function commit(analysis: Analysis, who: Committer, opts: CommitOptions = {}): Promise<CommitResult> {
    const accept = new Set(opts.accept ?? analysis.claims.map((c) => c.idx));
    const chosen = analysis.claims.filter((c) => accept.has(c.idx));
    const text = (c: AnalyzedClaim) => (opts.edits?.[c.idx] ?? c.text).trim();
    const status = who.trusted && analysis.document.source_kind !== 'agent-memory' ? 'active' : 'quarantined';
    const owner = who.username ?? who.id;
    const extractor = `${analysis.prompt_version}+${analysis.novelty_version}/${analysis.model}`;

    // Embeddings outside the transaction: a slow provider must not hold row locks.
    const vectors = new Map<number, string>();
    const missing = chosen.filter((c) => c.verdict !== 'duplicate' && (opts.edits?.[c.idx] || !opts.vectors?.has(c.idx)));
    for (const c of chosen) {
        const v = opts.vectors?.get(c.idx);
        if (v && !opts.edits?.[c.idx]) vectors.set(c.idx, toVectorLiteral(v));
    }
    if (missing.length && embeddingsAvailable()) {
        (await embed(missing.map(text))).forEach((v, i) => vectors.set(missing[i].idx, toVectorLiteral(v)));
    }
    const textRef = analysis.parsed_text ? await putBlob(Buffer.from(analysis.parsed_text, 'utf8'), 'text/plain') : null;

    const client = await pool.connect();
    const result: CommitResult = { status, created: [], attested: [], skipped: [], entities_created: [] };
    try {
        await client.query('BEGIN');
        const audit = (action: string, kind: string, id: string, detail: unknown) => client.query(`
            INSERT INTO audit_log (identity_id, token_id, action, target_kind, target_id, detail)
            VALUES ($1, $2, $3, $4, $5, $6)`, [who.id, who.tokenId ?? null, action, kind, id, JSON.stringify(detail)]);

        const d = analysis.document;
        await client.query(`
            INSERT INTO documents (content_hash, uri, title, source_kind, parser_version, blob_ref,
                                   media_type, text_ref, submitted_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (content_hash) DO UPDATE SET
                blob_ref = coalesce(documents.blob_ref, EXCLUDED.blob_ref),
                text_ref = coalesce(documents.text_ref, EXCLUDED.text_ref)`,
            [d.hash, d.uri, d.title, d.source_kind, analysis.parser_version, d.blob_ref, d.media_type, textRef, who.id]);

        for (const c of chosen) {
            if (c.subject && await ensureEntity(client, c, result)) {
                await audit('entity.create', 'entity', c.subject.id, { via: c.subject.via, cric_ref: c.subject.cric_ref });
            }
            const prov = [d.hash, c.span[0], c.span[1], c.quote, extractor, who.id, c.asserted_by];

            if (c.verdict === 'duplicate' && c.neighbour) {
                const added = await client.query(`
                    INSERT INTO claim_provenance (claim_id, document_id, span_start, span_end, span_text,
                                                  extractor_version, submitted_by, asserted_by)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`, [c.neighbour.id, ...prov]);
                const { rows } = await client.query<{ status: string }>(`
                    UPDATE claims SET
                        confidence = least($2::real, coalesce(confidence, 0.7) + CASE WHEN $4::boolean THEN $3::real ELSE 0 END),
                        status = CASE WHEN status = 'quarantined' AND $5::boolean THEN 'active' ELSE status END,
                        updated_at = now()
                    WHERE id = $1 RETURNING status`,
                    [c.neighbour.id, MAX_CONFIDENCE, ATTEST_STEP, (added.rowCount ?? 0) > 0, status === 'active']);
                await audit('claim.attest', 'claim', c.neighbour.id, { document: d.hash, idx: c.idx });
                result.attested.push({ idx: c.idx, id: c.neighbour.id, text: c.neighbour.text, now: rows[0]?.status ?? '?' });
                continue;
            }

            const { rows } = await client.query<{ id: string }>(`
                INSERT INTO claims (text, subject_entity_id, predicate, valid_from, valid_to, status,
                                    confidence, ttl_days, owner_identity, embedding, embedding_model)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::halfvec, $11)
                RETURNING id`, [
                text(c), c.subject?.id ?? null, c.predicate || null, c.valid_from, c.valid_to, status,
                c.confidence, null, owner,
                vectors.get(c.idx) ?? null, vectors.has(c.idx) ? config.embedding.model : null,
            ]);
            const id = rows[0].id;
            await client.query(`
                INSERT INTO claim_provenance (claim_id, document_id, span_start, span_end, span_text,
                                              extractor_version, submitted_by, asserted_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, ...prov]);
            await audit('claim.create', 'claim', id, {
                document: d.hash, idx: c.idx, verdict: c.verdict, status,
                ...(c.verdict === 'related' && { related_to: c.neighbour?.id, relation: c.relation }),
                ...(opts.edits?.[c.idx] && { edited_from: c.text }),
            });
            result.created.push({ idx: c.idx, id, text: text(c) });
        }
        result.skipped = analysis.claims.filter((c) => !accept.has(c.idx)).map((c) => c.idx);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
    return result;
}

/** Create the subject entity if resolution made it up; true when it was created. */
async function ensureEntity(client: PoolClient, c: AnalyzedClaim, result: CommitResult): Promise<boolean> {
    const s = c.subject;
    if (!s || s.via === 'known' || s.via === 'fuzzy') return false;
    const { rowCount } = await client.query(`
        INSERT INTO entities (id, kind, name, cric_ref, provisional) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO NOTHING`, [s.id, s.kind, s.name, s.cric_ref ?? null, s.via === 'new']);
    await client.query(`
        INSERT INTO entity_aliases (entity_id, alias) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING`,
        [s.id, s.name, s.id]);
    if (rowCount) result.entities_created.push(s.id);
    return (rowCount ?? 0) > 0;
}

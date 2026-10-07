/**
 * Hybrid claim search: the single most important query in OWL.
 *
 * Three ranked legs, fused with reciprocal-rank fusion (RRF):
 *   vector  — cosine distance on the claim embedding (skipped without a query embedding)
 *   lexical — Postgres full-text search, OR of the query's lexemes, so a natural question
 *             is not reduced to nothing by AND semantics
 *   entity  — claims whose subject entity is named in the query by name or alias
 *
 * Filters (status, subject entity, validity at a point in time) apply inside every leg,
 * not after fusion, so a filtered search cannot be starved by top-N results it discards.
 */
import { pool } from './pool.js';
import { embed, embeddingsAvailable, toVectorLiteral } from '../llm/embeddings.js';
import { log } from '../logger.js';

export const CURRENT_STATUSES = ['active', 'disputed'] as const;
export const ALL_STATUSES = ['active', 'disputed', 'quarantined', 'superseded', 'retired'] as const;
export type ClaimStatus = typeof ALL_STATUSES[number];

/** RRF constant; 60 is the value from the original paper and rarely worth tuning. */
const RRF_K = 60;
/** Entity matches are coarse — every claim about the entity ties — so they count half. */
const WEIGHTS = { vector: 1, lexical: 1, entity: 0.5 };
/** Candidates each leg contributes before fusion. */
const LEG_LIMIT = 50;

export interface SearchOptions {
    statuses?: readonly ClaimStatus[];
    /** Entity id; resolve names and aliases with resolveEntity() first. */
    entity?: string | null;
    /** Only claims valid at this instant; null for any time. Defaults to now. */
    at?: Date | null;
    limit?: number;
    /** Precomputed query embedding (the eval batches them); computed here otherwise. */
    embedding?: number[] | null;
}

export interface SearchHit {
    id: string;
    score: number;
    ranks: { vector: number | null; lexical: number | null; entity: number | null };
}

const FILTER = `
    c.status = ANY($2::text[])
    AND ($3::text IS NULL OR c.subject_entity_id = $3)
    AND ($4::timestamptz IS NULL OR (
        (c.valid_from IS NULL OR c.valid_from <= $4)
        AND (c.valid_to IS NULL OR c.valid_to > $4)))`;

const SEARCH_SQL = `
WITH q AS (
    SELECT CASE WHEN count(*) = 0 THEN NULL ELSE to_tsquery('simple', string_agg(
        '''' || replace(replace(lexeme, '\\', '\\\\'), '''', '''''') || '''', ' | ')) END AS tsq
    FROM unnest(to_tsvector('english', $1))
),
mentioned AS (
    SELECT DISTINCT a.entity_id FROM entity_aliases a
    WHERE length(a.alias) >= 2
      AND lower($1) ~ ('(^|[^[:alnum:]_])'
          || regexp_replace(lower(a.alias), '([.^$*+?()\\[\\]{}|\\\\-])', '\\\\\\1', 'g')
          || '($|[^[:alnum:]_])')
),
vec AS (
    SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> $5::halfvec) AS r
    FROM claims c
    WHERE $5::halfvec IS NOT NULL AND c.embedding IS NOT NULL AND ${FILTER}
    ORDER BY c.embedding <=> $5::halfvec
    LIMIT $6
),
lex AS (
    SELECT c.id, row_number() OVER (ORDER BY ts_rank(c.tsv, q.tsq, 1) DESC) AS r
    FROM claims c CROSS JOIN q
    WHERE q.tsq IS NOT NULL AND c.tsv @@ q.tsq AND ${FILTER}
    ORDER BY r
    LIMIT $6
),
ent AS (
    SELECT c.id, row_number() OVER (
        ORDER BY ts_rank(c.tsv, q.tsq, 1) DESC NULLS LAST, c.asserted_at DESC) AS r
    FROM claims c CROSS JOIN q
    WHERE c.subject_entity_id IN (SELECT entity_id FROM mentioned) AND ${FILTER}
    ORDER BY r
    LIMIT $6
),
legs AS (
    SELECT id, r, 'vector' AS leg, ${WEIGHTS.vector}::float8 AS w FROM vec
    UNION ALL SELECT id, r, 'lexical', ${WEIGHTS.lexical} FROM lex
    UNION ALL SELECT id, r, 'entity', ${WEIGHTS.entity} FROM ent
)
SELECT id,
       sum(w / (${RRF_K} + r)) AS score,
       min(r) FILTER (WHERE leg = 'vector')  AS vector_rank,
       min(r) FILTER (WHERE leg = 'lexical') AS lexical_rank,
       min(r) FILTER (WHERE leg = 'entity')  AS entity_rank
FROM legs
GROUP BY id
ORDER BY score DESC, id
LIMIT $7`;

export async function searchClaims(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    let embedding = opts.embedding ?? null;
    if (!embedding && opts.embedding === undefined && embeddingsAvailable()) {
        try {
            [embedding] = await embed([query]);
        } catch (err) {
            // Degrade to lexical + entity rather than failing the read.
            log.warn(`search: query embedding failed, vector leg skipped: ${err}`);
        }
    }
    const at = opts.at === undefined ? new Date() : opts.at;
    const { rows } = await pool.query<{
        id: string; score: number;
        vector_rank: string | null; lexical_rank: string | null; entity_rank: string | null;
    }>(SEARCH_SQL, [
        query,
        opts.statuses ?? CURRENT_STATUSES,
        opts.entity ?? null,
        at,
        embedding ? toVectorLiteral(embedding) : null,
        LEG_LIMIT,
        opts.limit ?? 8,
    ]);
    const n = (v: string | null) => (v === null ? null : Number(v));
    return rows.map((r) => ({
        id: r.id,
        score: Number(r.score),
        ranks: { vector: n(r.vector_rank), lexical: n(r.lexical_rank), entity: n(r.entity_rank) },
    }));
}

/**
 * An entity by id, name or alias, case-insensitively. Throws with the closest matches
 * when there is none, so a caller's typo produces a useful error rather than no results.
 */
export async function resolveEntity(ref: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(`
        SELECT id FROM entities WHERE id = $1 OR lower(name) = lower($1)
        UNION
        SELECT entity_id FROM entity_aliases WHERE lower(alias) = lower($1)`, [ref]);
    if (rows.length === 1) return rows[0].id;
    if (rows.length > 1) {
        throw new Error(`'${ref}' is ambiguous: ${rows.map((r) => r.id).join(', ')}`);
    }
    const near = await pool.query<{ id: string }>(`
        SELECT entity_id AS id, max(similarity(lower(alias), lower($1))) AS s
        FROM entity_aliases GROUP BY entity_id
        HAVING max(similarity(lower(alias), lower($1))) > 0.2
        ORDER BY s DESC LIMIT 5`, [ref]);
    const hint = near.rows.length ? `; did you mean: ${near.rows.map((r) => r.id).join(', ')}` : '';
    throw new Error(`unknown entity '${ref}'${hint}`);
}

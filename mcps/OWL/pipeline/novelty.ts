/**
 * Novelty: is a candidate claim already known?
 *
 * Embeddings find the candidates' nearest existing claims, but cosine similarity alone
 * cannot decide: two wordings of one fact land around 0.8-0.9, and different facts about
 * the same system land not far below. So the nearest few are shown to the cheap model,
 * which classifies each candidate in one batched call per document:
 *
 *   duplicate — states the same fact as an existing claim (commit adds a citation)
 *   refines   — the same fact with more or narrower detail      } kept, marked related,
 *   conflicts — the same aspect, but a different value           } for Phase 3
 *   new       — not covered
 *
 * Without a model (or when it fails), cosine thresholds decide, conservatively.
 */
import { pool } from '../db/pool.js';
import { chat, toVectorLiteral } from '../llm/provider.js';
import { log } from '../logger.js';
import { config } from '../config.js';

export const NOVELTY_VERSION = 'novelty-v1';

/** Below this, an existing claim is not shown to the model at all. */
const SHOW_AT = 0.55;
/** At or above this, a duplicate without asking. */
const CERTAIN_AT = 0.97;
/**
 * The model labels many plain restatements "refines" (a reworded claim always differs in
 * some detail). This close, a refinement adds nothing worth a second claim.
 */
const REFINES_IS_DUPLICATE_AT = 0.88;
/** Fallback thresholds, used only without the model. */
const FALLBACK_DUPLICATE_AT = 0.92;
const FALLBACK_RELATED_AT = 0.8;
const K = 3;

export interface Neighbour {
    id: string;
    external_id: string | null;
    text: string;
    status: string;
    subject: string | null;
    similarity: number;
}

export type Relation = 'new' | 'duplicate' | 'refines' | 'conflicts';

export interface NoveltyVerdict {
    relation: Relation;
    /** The existing claim the relation is to; for `new`, the nearest one if any. */
    neighbour: Neighbour | null;
    by: 'model' | 'similarity';
}

export async function neighbours(text: string, vector: number[] | null): Promise<Neighbour[]> {
    const { rows } = vector
        ? await pool.query<Neighbour>(`
            SELECT id, external_id, text, status, subject_entity_id AS subject,
                   1 - (embedding <=> $1::halfvec) AS similarity
            FROM claims WHERE status <> 'retired' AND embedding IS NOT NULL
            ORDER BY embedding <=> $1::halfvec LIMIT $2`, [toVectorLiteral(vector), K])
        : await pool.query<Neighbour>(`
            SELECT id, external_id, text, status, subject_entity_id AS subject, 1.0 AS similarity
            FROM claims WHERE status <> 'retired'
              AND lower(regexp_replace(text, '\\W+', ' ', 'g')) = lower(regexp_replace($1, '\\W+', ' ', 'g'))
            LIMIT 1`, [text]);
    return rows.map((n) => ({ ...n, similarity: Number(Number(n.similarity).toFixed(4)) }));
}

const SCHEMA = {
    name: 'owl_novelty',
    schema: {
        type: 'object',
        additionalProperties: false,
        required: ['verdicts'],
        properties: {
            verdicts: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['candidate', 'relation', 'existing'],
                    properties: {
                        candidate: { type: 'integer' },
                        relation: { type: 'string', enum: ['new', 'duplicate', 'refines', 'conflicts'] },
                        existing: { type: ['string', 'null'] },
                    },
                },
            },
        },
    },
};

const SYSTEM = `You maintain a knowledge base of factual claims. For each CANDIDATE claim, decide how it relates to the EXISTING claims listed under it.

- duplicate: an existing claim already says it — in other words, or as one part of a longer claim or list. Nothing new would be learned by adding it. A candidate that says LESS than an existing claim is a duplicate, not a refinement.
- refines: it is about the same fact as an existing claim and adds information the existing claim does not have: a detail, a condition or a narrower scope.
- conflicts: it is about the same aspect of the same system as an existing claim but states a different value (e.g. a different port, version or meaning).
- new: none of the existing claims covers it. Being about the same system is NOT enough for duplicate — the fact itself must be the same.

For duplicate, refines and conflicts, set "existing" to the label (E1, E2, ...) of that existing claim; for new, set it to null. Return one verdict per candidate.`;

export async function classify(
    candidates: { text: string; subject: string | null }[],
    near: Neighbour[][],
): Promise<NoveltyVerdict[]> {
    const fallback = (i: number): NoveltyVerdict => {
        const n = near[i][0] ?? null;
        const relation: Relation = !n ? 'new'
            : n.similarity >= FALLBACK_DUPLICATE_AT ? 'duplicate'
                : n.similarity >= FALLBACK_RELATED_AT && n.subject !== null && n.subject === candidates[i].subject
                    ? 'refines' : 'new';
        return { relation, neighbour: n, by: 'similarity' };
    };

    const verdicts: (NoveltyVerdict | null)[] = candidates.map((_c, i) => {
        const n = near[i][0];
        if (!n) return { relation: 'new', neighbour: null, by: 'similarity' };
        if (n.similarity >= CERTAIN_AT) return { relation: 'duplicate', neighbour: n, by: 'similarity' };
        return null;
    });
    const ask = verdicts.flatMap((v, i) => (v || !near[i].some((n) => n.similarity >= SHOW_AT) ? [] : [i]));

    // Label existing claims E1.. across the batch: models copy short labels reliably, uuids not.
    const labels = new Map<string, Neighbour>();
    const label = (n: Neighbour) => {
        for (const [k, v] of labels) if (v.id === n.id) return k;
        const k = `E${labels.size + 1}`;
        labels.set(k, n);
        return k;
    };
    const blocks = ask.map((i) => {
        const shown = near[i].filter((n) => n.similarity >= SHOW_AT);
        return `CANDIDATE ${i}: ${candidates[i].text}\n` +
            shown.map((n) => `  ${label(n)}: ${n.text}`).join('\n');
    });

    if (ask.length) {
        try {
            const reply = await chat<{ verdicts: { candidate: number; relation: Relation; existing: string | null }[] }>({
                tier: config.extractionTier, system: SYSTEM, user: blocks.join('\n\n'), schema: SCHEMA,
            });
            for (const v of reply.value.verdicts) {
                if (!ask.includes(v.candidate) || verdicts[v.candidate]) continue;
                // Only a claim shown under this candidate counts (labels are shared across the
                // batch), and its similarity is the one to this candidate.
                const labelled = v.existing ? labels.get(v.existing) : undefined;
                const n = labelled ? near[v.candidate].find((x) => x.id === labelled.id) ?? null : null;
                if (v.relation !== 'new' && !n) continue;
                const relation: Relation = v.relation === 'refines' && n && n.similarity >= REFINES_IS_DUPLICATE_AT
                    ? 'duplicate' : v.relation;
                verdicts[v.candidate] = {
                    relation,
                    neighbour: relation === 'new' ? near[v.candidate][0] ?? null : n,
                    by: 'model',
                };
            }
        } catch (err) {
            log.warn(`novelty: model triage failed, falling back to similarity: ${err}`);
        }
    }
    return verdicts.map((v, i) => v ?? fallback(i));
}

/**
 * Loading claims for output, and the graph reads over them.
 *
 * Every claim that leaves OWL goes through shapeClaims(), which attaches provenance, age,
 * status and explicit flags. A disputed or superseded claim must never come back looking
 * settled, so the flags are computed here, once, rather than by each tool.
 */
import { pool } from './pool.js';

const DAY_MS = 86_400_000;

export interface Citation {
    source_kind: string;
    uri: string;
    title: string | null;
    document: string;
    span: [number, number];
    quote: string;
    submitted_by: string;
    asserted_by: string | null;
}

export interface Related {
    id: string;
    external_id: string | null;
    type: string;
    text: string;
    status: string;
    at: string;
}

export interface ShapedClaim {
    id: string;
    external_id: string | null;
    text: string;
    subject: { id: string; name: string } | null;
    predicate: string | null;
    status: string;
    valid_from: string | null;
    valid_to: string | null;
    asserted_at: string;
    age_days: number;
    confidence: number | null;
    ttl_days: number | null;
    owner: string;
    /** Empty means current, confirmed and fresh. Anything else must be shown to the asker. */
    flags: string[];
    warnings: string[];
    superseded_by: Related[];
    supersedes: Related[];
    related: Related[];
    disputes: { id: string; kind: string; state: string; other_claim: string; opened_at: string }[];
    citations: Citation[];
}

interface ClaimRow {
    id: string;
    external_id: string | null;
    text: string;
    subject_entity_id: string | null;
    subject_name: string | null;
    predicate: string | null;
    valid_from: Date | null;
    valid_to: Date | null;
    asserted_at: Date;
    retracted_at: Date | null;
    status: string;
    confidence: number | null;
    ttl_days: number | null;
    owner_identity: string;
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Claims by id, shaped, in the order given. Unknown ids are dropped. */
export async function shapeClaims(ids: string[], now = new Date()): Promise<ShapedClaim[]> {
    if (ids.length === 0) return [];
    const [claims, prov, edges, disputes] = await Promise.all([
        pool.query<ClaimRow>(`
            SELECT c.id, c.external_id, c.text, c.subject_entity_id, e.name AS subject_name,
                   c.predicate, c.valid_from, c.valid_to, c.asserted_at, c.retracted_at,
                   c.status, c.confidence, c.ttl_days, c.owner_identity
            FROM claims c LEFT JOIN entities e ON e.id = c.subject_entity_id
            WHERE c.id = ANY($1::uuid[])`, [ids]),
        pool.query<{
            claim_id: string; source_kind: string; uri: string; title: string | null;
            content_hash: string; span_start: number; span_end: number; span_text: string;
            submitted_by: string; asserted_by: string | null; created_at: Date;
        }>(`
            SELECT p.claim_id, d.source_kind, d.uri, d.title, d.content_hash, p.span_start,
                   p.span_end, p.span_text, p.submitted_by, p.asserted_by, p.created_at
            FROM claim_provenance p JOIN documents d ON d.content_hash = p.document_id
            WHERE p.claim_id = ANY($1::uuid[])
            ORDER BY p.created_at`, [ids]),
        pool.query<{
            from_claim: string; to_claim: string; type: string; created_at: Date;
            from_external_id: string | null; from_text: string; from_status: string;
            to_external_id: string | null; to_text: string; to_status: string;
        }>(`
            SELECT e.from_claim, e.to_claim, e.type, e.created_at,
                   f.external_id AS from_external_id, f.text AS from_text, f.status AS from_status,
                   t.external_id AS to_external_id, t.text AS to_text, t.status AS to_status
            FROM claim_edges e
            JOIN claims f ON f.id = e.from_claim
            JOIN claims t ON t.id = e.to_claim
            WHERE e.from_claim = ANY($1::uuid[]) OR e.to_claim = ANY($1::uuid[])`, [ids]),
        pool.query<{
            id: string; claim_a: string; claim_b: string; kind: string; state: string;
            opened_at: Date;
        }>(`
            SELECT id, claim_a, claim_b, kind, state, opened_at FROM disputes
            WHERE state <> 'resolved'
              AND (claim_a = ANY($1::uuid[]) OR claim_b = ANY($1::uuid[]))`, [ids]),
    ]);

    const byId = new Map(claims.rows.map((r) => [r.id, r]));
    return ids.filter((id) => byId.has(id)).map((id) => {
        const c = byId.get(id)!;
        const citations = prov.rows.filter((p) => p.claim_id === id);
        const lastVerified = Math.max(
            c.asserted_at.getTime(),
            ...citations.map((p) => p.created_at.getTime()),
        );

        // The other end of an edge, as seen from this claim.
        const related = (e: typeof edges.rows[number]): Related => {
            const outgoing = e.from_claim === id;
            return {
                id: outgoing ? e.to_claim : e.from_claim,
                external_id: outgoing ? e.to_external_id : e.from_external_id,
                type: e.type,
                text: outgoing ? e.to_text : e.from_text,
                status: outgoing ? e.to_status : e.from_status,
                at: day(e.created_at)!,
            };
        };
        const mine = edges.rows.filter((e) => e.from_claim === id || e.to_claim === id);
        const supersededBy = mine.filter((e) => e.type === 'supersedes' && e.to_claim === id).map(related);
        const supersedes = mine.filter((e) => e.type === 'supersedes' && e.from_claim === id).map(related);
        const other = mine.filter((e) => e.type !== 'supersedes').map(related);
        const open = disputes.rows.filter((d) => d.claim_a === id || d.claim_b === id);

        const flags: string[] = [];
        const warnings: string[] = [];
        if (c.status === 'superseded' || supersededBy.length) {
            flags.push('superseded');
            const by = supersededBy.map((r) => r.external_id ?? r.id).join(', ') || 'a newer claim';
            warnings.push(`SUPERSEDED by ${by}${c.valid_to ? ` as of ${day(c.valid_to)}` : ''}: not current.`);
        }
        if (c.status === 'disputed' || open.length) {
            flags.push('disputed');
            warnings.push('DISPUTED: an open dispute contests this claim; present both sides.');
        }
        if (c.status === 'quarantined') {
            flags.push('unconfirmed');
            warnings.push('UNCONFIRMED: from an untrusted source and not yet confirmed.');
        }
        if (c.status === 'retired' || c.retracted_at) {
            flags.push('retired');
            warnings.push(`RETIRED${c.retracted_at ? ` on ${day(c.retracted_at)}` : ''}: no longer believed.`);
        }
        if (c.valid_to && c.valid_to <= now && !flags.includes('superseded')) {
            flags.push('expired');
            warnings.push(`NO LONGER VALID since ${day(c.valid_to)}.`);
        }
        if (c.valid_from && c.valid_from > now) {
            flags.push('not_yet_valid');
            warnings.push(`NOT YET VALID: takes effect ${day(c.valid_from)}.`);
        }
        if (c.ttl_days && now.getTime() - lastVerified > c.ttl_days * DAY_MS) {
            flags.push('stale');
            const age = Math.floor((now.getTime() - lastVerified) / DAY_MS);
            warnings.push(`STALE: not re-verified in ${age} days (re-verify every ${c.ttl_days}).`);
        }

        return {
            id: c.id,
            external_id: c.external_id,
            text: c.text,
            subject: c.subject_entity_id
                ? { id: c.subject_entity_id, name: c.subject_name ?? c.subject_entity_id }
                : null,
            predicate: c.predicate,
            status: c.status,
            valid_from: day(c.valid_from),
            valid_to: day(c.valid_to),
            asserted_at: day(c.asserted_at)!,
            age_days: Math.floor((now.getTime() - c.asserted_at.getTime()) / DAY_MS),
            confidence: c.confidence,
            ttl_days: c.ttl_days,
            owner: c.owner_identity,
            flags,
            warnings,
            superseded_by: supersededBy,
            supersedes,
            related: other,
            disputes: open.map((d) => ({
                id: d.id,
                kind: d.kind,
                state: d.state,
                other_claim: d.claim_a === id ? d.claim_b : d.claim_a,
                opened_at: day(d.opened_at)!,
            })),
            citations: citations.map((p) => ({
                source_kind: p.source_kind,
                uri: p.uri,
                title: p.title,
                document: p.content_hash,
                span: [p.span_start, p.span_end] as [number, number],
                quote: p.span_text,
                submitted_by: p.submitted_by,
                asserted_by: p.asserted_by,
            })),
        };
    });
}

/** A claim by uuid or external id (e.g. 'seed:s01'). */
export async function resolveClaimId(ref: string): Promise<string> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
    const { rows } = await pool.query<{ id: string }>(
        isUuid ? 'SELECT id FROM claims WHERE id = $1' : 'SELECT id FROM claims WHERE external_id = $1',
        [ref],
    );
    if (!rows.length) throw new Error(`unknown claim '${ref}'`);
    return rows[0].id;
}

/**
 * Claims reachable from a set of starting claims over edges of any type, in either
 * direction, up to `depth` hops. Returns each claim with its distance.
 */
export async function walkEdges(start: string[], depth: number): Promise<Map<string, number>> {
    const { rows } = await pool.query<{ id: string; hops: number }>(`
        WITH RECURSIVE walk (id, hops, path) AS (
            SELECT id, 0, ARRAY[id] FROM unnest($1::uuid[]) AS id
            UNION ALL
            SELECT CASE WHEN e.from_claim = w.id THEN e.to_claim ELSE e.from_claim END,
                   w.hops + 1,
                   w.path || CASE WHEN e.from_claim = w.id THEN e.to_claim ELSE e.from_claim END
            FROM walk w
            JOIN claim_edges e ON e.from_claim = w.id OR e.to_claim = w.id
            WHERE w.hops < $2
              AND NOT (CASE WHEN e.from_claim = w.id THEN e.to_claim ELSE e.from_claim END = ANY(w.path))
        )
        SELECT id, min(hops) AS hops FROM walk GROUP BY id`, [start, depth]);
    return new Map(rows.map((r) => [r.id, Number(r.hops)]));
}

/**
 * The full supersession chain through a claim: everything it replaced and everything
 * that replaced it, oldest first.
 */
export async function supersessionChain(id: string): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(`
        WITH RECURSIVE
        older (id, pos, path) AS (
            SELECT $1::uuid, 0, ARRAY[$1::uuid]
            UNION ALL
            SELECT e.to_claim, o.pos - 1, o.path || e.to_claim FROM older o
            JOIN claim_edges e ON e.from_claim = o.id AND e.type = 'supersedes'
            WHERE NOT e.to_claim = ANY(o.path)
        ),
        newer (id, pos, path) AS (
            SELECT $1::uuid, 0, ARRAY[$1::uuid]
            UNION ALL
            SELECT e.from_claim, n.pos + 1, n.path || e.from_claim FROM newer n
            JOIN claim_edges e ON e.to_claim = n.id AND e.type = 'supersedes'
            WHERE NOT e.from_claim = ANY(n.path)
        )
        -- Graph position, not dates: a claim's dates can be missing or reflect when OWL
        -- learned it, but "A supersedes B" always puts B first.
        SELECT id FROM (SELECT id, pos FROM older UNION SELECT id, pos FROM newer) chain
        GROUP BY id ORDER BY min(pos)`, [id]);
    return rows.map((r) => r.id);
}

/** Record a read, so disputes can be ranked by real traffic later. Never fails the read. */
export async function logQuery(
    identityId: string | undefined,
    tool: string,
    query: string | null,
    filters: unknown,
    shaped: ShapedClaim[],
): Promise<void> {
    await pool.query(`
        INSERT INTO query_log (identity_id, tool, query, filters, result_claim_ids, hit_disputed)
        VALUES ($1, $2, $3, $4, $5::uuid[], $6)`, [
        identityId ?? null,
        tool,
        query,
        JSON.stringify(filters ?? {}),
        shaped.map((c) => c.id),
        shaped.some((c) => c.flags.includes('disputed')),
    ]).catch(() => undefined);
}

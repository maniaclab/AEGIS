import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runTool } from '../logger.js';
import { pool } from '../db/pool.js';
import {
    ALL_STATUSES, CURRENT_STATUSES, ClaimStatus, resolveEntity, searchClaims,
} from '../db/search.js';
import {
    logQuery, resolveClaimId, shapeClaims, supersessionChain, walkEdges,
} from '../db/claims.js';
import type { Identity } from '../identity.js';

const READ_ONLY = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
} as const;

const json = (v: unknown) => JSON.stringify(v, null, 2);

function parseDate(value: string | undefined, name: string): Date | undefined {
    if (!value) return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new Error(`${name}: not a date: '${value}'`);
    return d;
}

async function entitySummary(id: string) {
    const { rows } = await pool.query<{
        id: string; kind: string; name: string; cric_ref: string | null; provisional: boolean;
        aliases: string[];
    }>(`
        SELECT e.id, e.kind, e.name, e.cric_ref, e.provisional,
               coalesce(array_agg(a.alias ORDER BY a.alias) FILTER (WHERE a.alias IS NOT NULL), '{}') AS aliases
        FROM entities e LEFT JOIN entity_aliases a ON a.entity_id = e.id
        WHERE e.id = $1 GROUP BY e.id`, [id]);
    return rows[0];
}

export function registerReadTools(server: McpServer, identity?: Identity): void {
    server.registerTool(
        'search_knowledge',
        {
            title: 'Search knowledge',
            description:
                'Search OWL\'s curated claims about ATLAS systems with a natural-language ' +
                'question. Returns atomic claims, each with citations, status, age and flags. ' +
                'By default only claims that are current (valid now, not superseded or ' +
                'retired) and confirmed are returned. Always relay `warnings` to the user: a ' +
                'claim flagged superseded, disputed, unconfirmed or stale is not settled fact.',
            annotations: READ_ONLY,
            inputSchema: {
                query: z.string().min(1).describe('The question or keywords'),
                entity: z.string().optional()
                    .describe('Restrict to claims about one system, site or service (id, name or alias)'),
                as_of: z.string().optional()
                    .describe('ISO date: return what was true then instead of now'),
                include_history: z.boolean().optional()
                    .describe('Also return superseded and retired claims, from any time'),
                include_unconfirmed: z.boolean().optional()
                    .describe('Also return quarantined claims from untrusted sources'),
                limit: z.number().int().min(1).max(25).optional().describe('Default 8'),
            },
        },
        async (args) => runTool('search_knowledge', args, async () => {
            const statuses = new Set<ClaimStatus>(args.include_history ? ALL_STATUSES : CURRENT_STATUSES);
            if (!args.include_history && args.include_unconfirmed) statuses.add('quarantined');
            if (args.include_history && !args.include_unconfirmed) statuses.delete('quarantined');
            const entity = args.entity ? await resolveEntity(args.entity) : null;
            const at = args.include_history && !args.as_of ? null : (parseDate(args.as_of, 'as_of') ?? new Date());

            const hits = await searchClaims(args.query, {
                statuses: [...statuses], entity, at, limit: args.limit ?? 8,
            });
            const shaped = await shapeClaims(hits.map((h) => h.id));
            await logQuery(identity?.id, 'search_knowledge', args.query, args, shaped);
            const match = new Map(hits.map((h) => [h.id, h]));
            return json({
                query: args.query,
                filters: { entity, as_of: at ? at.toISOString().slice(0, 10) : 'any', statuses: [...statuses] },
                results: shaped.map((c) => ({
                    ...c,
                    match: { score: Number(match.get(c.id)!.score.toFixed(5)), ranks: match.get(c.id)!.ranks },
                })),
                ...(shaped.length === 0 && {
                    note: 'No claims matched. OWL knows nothing about this yet; do not infer an answer from the silence.',
                }),
            });
        }),
    );

    server.registerTool(
        'get_claim',
        {
            title: 'Get claim',
            description:
                'One claim in full — citations, edges, open disputes — plus its supersession ' +
                'chain: every claim it replaced and every claim that replaced it, oldest first.',
            annotations: READ_ONLY,
            inputSchema: {
                claim: z.string().describe('Claim uuid or external id (e.g. seed:s01)'),
            },
        },
        async (args) => runTool('get_claim', args, async () => {
            const id = await resolveClaimId(args.claim);
            const [claim] = await shapeClaims([id]);
            const chain = await supersessionChain(id);
            const shapedChain = chain.length > 1 ? await shapeClaims(chain) : [];
            await logQuery(identity?.id, 'get_claim', args.claim, args, [claim]);
            return json({
                ...claim,
                supersession_chain: shapedChain.map((c) => ({
                    id: c.id, external_id: c.external_id, text: c.text, status: c.status,
                    valid_from: c.valid_from, valid_to: c.valid_to,
                })),
            });
        }),
    );

    server.registerTool(
        'traverse_entity',
        {
            title: 'Traverse entity',
            description:
                'Everything OWL knows about one system, site or service: the entity, its ' +
                'aliases, the claims about it, and claims reachable from them over edges ' +
                '(supersedes, contradicts, refines, qualifies, resolves) up to `depth` hops, ' +
                'with the other entities they are about.',
            annotations: READ_ONLY,
            inputSchema: {
                entity: z.string().describe('Entity id, name or alias'),
                depth: z.number().int().min(0).max(3).optional().describe('Edge hops to follow; default 1'),
                include_history: z.boolean().optional()
                    .describe('Include superseded and retired claims; default false'),
            },
        },
        async (args) => runTool('traverse_entity', args, async () => {
            const id = await resolveEntity(args.entity);
            const statuses = args.include_history ? ALL_STATUSES : CURRENT_STATUSES;
            const { rows } = await pool.query<{ id: string }>(`
                SELECT id FROM claims WHERE subject_entity_id = $1 AND status = ANY($2::text[])
                ORDER BY predicate, asserted_at`, [id, statuses]);
            const own = rows.map((r) => r.id);
            const reached = await walkEdges(own, args.depth ?? 1);
            const ownSet = new Set(own);
            const extra = [...reached.keys()].filter((c) => !ownSet.has(c));
            const shaped = await shapeClaims([...own, ...extra]);
            const linked = shaped.filter((c) => !ownSet.has(c.id))
                .filter((c) => args.include_history || (CURRENT_STATUSES as readonly string[]).includes(c.status));
            await logQuery(identity?.id, 'traverse_entity', args.entity, args, shaped);
            return json({
                entity: await entitySummary(id),
                claims: shaped.filter((c) => ownSet.has(c.id)),
                linked_claims: linked.map((c) => ({ hops: reached.get(c.id), ...c })),
                related_entities: [...new Set(linked.map((c) => c.subject?.id).filter((e) => e && e !== id))],
            });
        }),
    );

    server.registerTool(
        'get_timeline',
        {
            title: 'Get timeline',
            description:
                'How knowledge about a system changed over time: every claim about the entity, ' +
                'current or not, oldest first, with validity windows and what superseded what.',
            annotations: READ_ONLY,
            inputSchema: {
                entity: z.string().describe('Entity id, name or alias'),
                predicate: z.string().optional()
                    .describe('Only one aspect, e.g. "version"; see predicates in traverse_entity output'),
            },
        },
        async (args) => runTool('get_timeline', args, async () => {
            const id = await resolveEntity(args.entity);
            const { rows } = await pool.query<{ id: string }>(`
                SELECT id FROM claims
                WHERE subject_entity_id = $1 AND ($2::text IS NULL OR predicate = $2)
                ORDER BY valid_from NULLS FIRST, valid_to NULLS LAST, asserted_at`, [id, args.predicate ?? null]);
            const shaped = await shapeClaims(rows.map((r) => r.id));
            await logQuery(identity?.id, 'get_timeline', args.entity, args, shaped);
            return json({
                entity: await entitySummary(id),
                timeline: shaped.map((c) => ({
                    id: c.id,
                    external_id: c.external_id,
                    predicate: c.predicate,
                    text: c.text,
                    status: c.status,
                    valid_from: c.valid_from,
                    valid_to: c.valid_to,
                    asserted_at: c.asserted_at,
                    flags: c.flags,
                    supersedes: c.supersedes.map((r) => r.external_id ?? r.id),
                    superseded_by: c.superseded_by.map((r) => r.external_id ?? r.id),
                })),
            });
        }),
    );

    server.registerTool(
        'list_disputes',
        {
            title: 'List disputes',
            description:
                'Contradictions OWL has not settled, ranked by how often real queries returned ' +
                'one of the disputed claims in the last 30 days.',
            annotations: READ_ONLY,
            inputSchema: {
                state: z.enum(['open', 'escalated', 'parked', 'resolved', 'unresolved']).optional()
                    .describe('Default unresolved (open, escalated or parked)'),
                limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
            },
        },
        async (args) => runTool('list_disputes', args, async () => {
            const state = args.state ?? 'unresolved';
            const { rows } = await pool.query<{
                id: string; claim_a: string; claim_b: string; kind: string; state: string;
                parties: string[]; opened_at: Date; escalated_at: Date | null; hits: string;
            }>(`
                SELECT d.id, d.claim_a, d.claim_b, d.kind, d.state, d.parties, d.opened_at,
                       d.escalated_at,
                       (SELECT count(*) FROM query_log q
                        WHERE q.at > now() - interval '30 days'
                          AND q.result_claim_ids && ARRAY[d.claim_a, d.claim_b]) AS hits
                FROM disputes d
                WHERE CASE WHEN $1 = 'unresolved' THEN d.state <> 'resolved' ELSE d.state = $1 END
                ORDER BY hits DESC, d.opened_at
                LIMIT $2`, [state, args.limit ?? 20]);
            const claims = new Map(
                (await shapeClaims([...new Set(rows.flatMap((d) => [d.claim_a, d.claim_b]))]))
                    .map((c) => [c.id, c]),
            );
            const brief = (id: string) => {
                const c = claims.get(id);
                return c && { id, external_id: c.external_id, text: c.text, owner: c.owner, citations: c.citations };
            };
            return json({
                state,
                disputes: rows.map((d) => ({
                    id: d.id,
                    kind: d.kind,
                    state: d.state,
                    parties: d.parties,
                    opened_at: d.opened_at.toISOString().slice(0, 10),
                    escalated_at: d.escalated_at?.toISOString().slice(0, 10) ?? null,
                    query_hits_30d: Number(d.hits),
                    a: brief(d.claim_a),
                    b: brief(d.claim_b),
                })),
            });
        }),
    );

    server.registerTool(
        'fetch_source',
        {
            title: 'Fetch source',
            description:
                'The sources behind a claim: for each, the document (kind, uri, content hash) ' +
                'and the exact cited span with its character offsets.',
            annotations: READ_ONLY,
            inputSchema: {
                claim: z.string().describe('Claim uuid or external id'),
            },
        },
        async (args) => runTool('fetch_source', args, async () => {
            const id = await resolveClaimId(args.claim);
            const [claim] = await shapeClaims([id]);
            return json({
                claim: { id: claim.id, external_id: claim.external_id, text: claim.text },
                citations: claim.citations,
                note: 'Only the cited spans are served. Full originals arrive with the blob store (Phase 2).',
            });
        }),
    );
}

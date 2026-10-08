import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runTool } from '../logger.js';
import { pool } from '../db/pool.js';
import { checkRateLimit, createJob, finishJob, getJob } from '../db/jobs.js';
import { resolveClaimId, shapeClaims } from '../db/claims.js';
import { analyze, Analysis, jobKey, prepare, sourcePayload } from '../pipeline/ingest.js';
import { commit, Committer } from '../pipeline/commit.js';
import { DocumentPayload, summarize } from '../pipeline/run.js';
import type { Identity } from '../identity.js';

const CONFIRM_WINDOW_MS = 24 * 3600_000;

const json = (v: unknown) => JSON.stringify(v, null, 2);

function requireSubmit(identity?: Identity): Identity {
    if (!identity?.canSubmit) {
        throw new Error('this credential is read-only: log in with CERN (OAuth) to submit knowledge');
    }
    return identity;
}

function requireTrusted(identity?: Identity): Identity {
    if (!identity?.trusted) throw new Error('only a trusted writer can do this');
    return identity;
}

const committer = (i: Identity): Committer => ({
    id: i.id, username: i.username, kind: i.kind, trusted: i.trusted, tokenId: i.tokenId,
});

/** What the submitter sees: enough to judge each claim, nothing internal. */
function preview(a: Analysis) {
    return a.claims.map((c) => ({
        idx: c.idx,
        text: c.text,
        subject: !c.subject ? '(none — review should assign one)'
            : c.subject.via === 'known' || c.subject.via === 'fuzzy'
            ? c.subject.id
            : `${c.subject.id} (NEW ${c.subject.via === 'cric' ? `entity, CRIC site ${c.subject.cric_ref}` : 'provisional entity'})`,
        verdict: c.verdict === 'related' ? `related (${c.relation})` : c.verdict,
        ...(c.neighbour && c.verdict !== 'new' && {
            existing: {
                id: c.neighbour.external_id ?? c.neighbour.id,
                text: c.neighbour.text,
                status: c.neighbour.status,
                similarity: c.neighbour.similarity,
            },
        }),
        quote: c.quote,
        ...(c.valid_from && { valid_from: c.valid_from }),
        ...(c.valid_to && { valid_to: c.valid_to }),
        ...(c.asserted_by && { asserted_by: c.asserted_by }),
    }));
}

export function registerWriteTools(server: McpServer, identity?: Identity): void {
    server.registerTool(
        'submit_knowledge',
        {
            title: 'Submit knowledge',
            description:
                'Give OWL a piece of knowledge — free text, or a conversation in which only the ' +
                'human turns count as assertions. OWL extracts atomic claims, checks each against ' +
                'what it already knows, and returns them for review WITHOUT storing anything. Show ' +
                'the claims to the user, then call confirm_submission with the handle to store the ' +
                'ones they accept (optionally correcting their wording). Unconfirmed submissions ' +
                'expire after 24 hours.',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            inputSchema: {
                text: z.string().optional().describe('The knowledge, in plain text or markdown'),
                conversation: z.array(z.object({ role: z.string(), content: z.string() })).optional()
                    .describe('A transcript instead of text; only user/human turns are treated as assertions'),
                title: z.string().optional().describe('Short title of the source'),
                source: z.string().optional().describe('Where this comes from, e.g. a URL or thread link'),
            },
        },
        async (args) => runTool('submit_knowledge', { ...args, text: args.text && `${args.text.length} chars` }, async () => {
            const who = requireSubmit(identity);
            if (!args.text === !args.conversation) throw new Error('give exactly one of text or conversation');
            await checkRateLimit(who.id, who.trusted);

            const source = await prepare({
                content: args.text, turns: args.conversation, uri: args.source, title: args.title,
                mediaType: 'text/markdown', sourceKind: args.conversation ? 'conversation' : 'statement',
            });
            const key = jobKey(source, who.id);
            const existing = await createJob<unknown, Analysis>({
                key, kind: 'submit_knowledge', state: 'awaiting_confirmation', payload: {}, submittedBy: who.id,
                expiresAt: new Date(Date.now() + CONFIRM_WINDOW_MS),
            });
            if (!existing.created && existing.job.state !== 'awaiting_confirmation') {
                return json({
                    handle: existing.job.id, state: existing.job.state,
                    note: 'This exact text was already submitted by you; nothing new to do.',
                });
            }
            let analysis = existing.job.result;
            if (existing.created || !analysis) {
                analysis = (await analyze(source)).analysis;
                await pool.query('UPDATE jobs SET result = $2, updated_at = now() WHERE id = $1',
                    [existing.job.id, JSON.stringify(analysis)]);
            }
            const lands = who.trusted ? 'active' : 'quarantined (until a trusted writer confirms them)';
            return json({
                handle: existing.job.id,
                summary: summarize(analysis),
                claims: preview(analysis),
                dropped: analysis.dropped,
                next:
                    `Nothing is stored yet. confirm_submission(handle) stores the accepted claims as ${lands}; ` +
                    '"duplicate" claims are not stored again — your source is added as another citation of the existing claim.',
            });
        }),
    );

    server.registerTool(
        'confirm_submission',
        {
            title: 'Confirm submission',
            description:
                'Store the claims of a submit_knowledge preview. By default all are accepted; ' +
                'pass `accept` or `reject` (lists of idx) to choose, and `edits` to correct a ' +
                'claim\'s wording. `reject_all` discards the submission.',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            inputSchema: {
                handle: z.string().describe('The handle returned by submit_knowledge'),
                accept: z.array(z.number().int()).optional(),
                reject: z.array(z.number().int()).optional(),
                edits: z.array(z.object({ idx: z.number().int(), text: z.string().min(10) })).optional(),
                reject_all: z.boolean().optional(),
            },
        },
        async (args) => runTool('confirm_submission', args, async () => {
            const who = requireSubmit(identity);
            const job = await getJob<unknown, Analysis>(args.handle);
            if (!job || job.kind !== 'submit_knowledge' || job.submitted_by !== who.id) {
                throw new Error(`no submission '${args.handle}' of yours`);
            }
            if (job.state !== 'awaiting_confirmation' || !job.result) {
                throw new Error(`submission is ${job.state}; only a pending submission can be confirmed`);
            }
            if (job.expires_at && job.expires_at < new Date()) throw new Error('submission expired; submit it again');
            if (args.reject_all) {
                await finishJob(job.id, 'rejected', job.result);
                return json({ handle: job.id, state: 'rejected' });
            }
            const all = job.result.claims.map((c) => c.idx);
            const accept = (args.accept ?? all).filter((i) => !(args.reject ?? []).includes(i));
            const unknown = [...accept, ...(args.edits ?? []).map((e) => e.idx)].filter((i) => !all.includes(i));
            if (unknown.length) throw new Error(`no claims with idx ${unknown.join(', ')}`);

            const result = await commit(job.result, committer(who), {
                accept,
                edits: Object.fromEntries((args.edits ?? []).map((e) => [e.idx, e.text])),
            });
            const { parsed_text: _drop, ...stored } = job.result;
            await finishJob(job.id, 'done', { analysis: stored, commit: result }, job.result.document.hash);
            return json({ handle: job.id, state: 'done', summary: summarize(job.result, result), ...result });
        }),
    );

    server.registerTool(
        'submit_document',
        {
            title: 'Submit document',
            description:
                'Queue a whole document for extraction — markdown or plain text, given inline or ' +
                'as an https URL on an allowed host. Returns a job id; poll get_job. Claims are ' +
                'committed when extraction finishes, without a confirmation step: active for a ' +
                'trusted writer, quarantined otherwise.',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            inputSchema: {
                content: z.string().optional().describe('The document text'),
                url: z.string().url().optional().describe('Or an https URL to fetch it from'),
                title: z.string().optional(),
                uri: z.string().optional().describe('Canonical location, if different from url (e.g. a git blob URL)'),
                media_type: z.enum(['text/markdown', 'text/plain']).optional().describe('Default text/markdown'),
                source_kind: z.string().regex(/^[a-z][a-z0-9-]*$/).optional()
                    .describe('e.g. document, wiki, agent-memory (always quarantined); default document'),
            },
        },
        async (args) => runTool('submit_document', { ...args, content: args.content && `${args.content.length} chars` }, async () => {
            const who = requireSubmit(identity);
            if (!args.content === !args.url) throw new Error('give exactly one of content or url');
            await checkRateLimit(who.id, who.trusted);
            const source = await prepare({
                content: args.content, url: args.url, uri: args.uri, title: args.title,
                mediaType: args.media_type, sourceKind: args.source_kind,
            });
            const { job, created } = await createJob<DocumentPayload, unknown>({
                key: jobKey(source, who.id), kind: 'submit_document', state: 'queued',
                payload: { source: sourcePayload(source), committer: committer(who) }, submittedBy: who.id,
            });
            return json({
                job_id: job.id,
                state: job.state,
                ...(!created && { note: 'Already submitted; this is the existing job.' }),
            });
        }),
    );

    server.registerTool(
        'get_job',
        {
            title: 'Get job',
            description: 'State and outcome of a submission: queued, running, done (with what was committed), failed (with why).',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            inputSchema: { job_id: z.string() },
        },
        async (args) => runTool('get_job', args, async () => {
            const job = await getJob<unknown, { summary?: string; commit?: unknown; analysis?: Analysis }>(args.job_id);
            if (!job || !(job.submitted_by === identity?.id || identity?.trusted)) {
                throw new Error(`no job '${args.job_id}' visible to you`);
            }
            return json({
                job_id: job.id,
                kind: job.kind,
                state: job.state,
                attempts: job.attempts,
                submitted_by: job.submitted_by,
                created_at: job.created_at,
                updated_at: job.updated_at,
                ...(job.error && { error: job.error }),
                ...(job.result?.summary && { summary: job.result.summary }),
                ...(job.result?.commit ? { commit: job.result.commit } : {}),
                ...(job.result?.analysis && { dropped: job.result.analysis.dropped }),
            });
        }),
    );

    server.registerTool(
        'list_quarantine',
        {
            title: 'List quarantine',
            description:
                'Claims waiting for a trusted writer: submitted by untrusted identities or ' +
                'extracted from agent memory. Review them, then confirm_claim or retire_claim.',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            inputSchema: {
                source_kind: z.string().optional().describe('Only claims cited from this kind of source, e.g. agent-memory'),
                entity: z.string().optional().describe('Only claims about this entity id'),
                limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
                offset: z.number().int().min(0).optional(),
            },
        },
        async (args) => runTool('list_quarantine', args, async () => {
            const { rows } = await pool.query<{ id: string; total: string }>(`
                SELECT c.id, count(*) OVER () AS total FROM claims c
                WHERE c.status = 'quarantined'
                  AND ($1::text IS NULL OR EXISTS (
                      SELECT 1 FROM claim_provenance p JOIN documents d ON d.content_hash = p.document_id
                      WHERE p.claim_id = c.id AND d.source_kind = $1))
                  AND ($2::text IS NULL OR c.subject_entity_id = $2)
                ORDER BY c.subject_entity_id, c.asserted_at
                LIMIT $3 OFFSET $4`, [args.source_kind ?? null, args.entity ?? null, args.limit ?? 50, args.offset ?? 0]);
            const shaped = await shapeClaims(rows.map((r) => r.id));
            return json({
                total: Number(rows[0]?.total ?? 0),
                claims: shaped.map((c) => ({
                    id: c.id, text: c.text, subject: c.subject?.id, predicate: c.predicate,
                    asserted_at: c.asserted_at, owner: c.owner,
                    citations: c.citations.map((p) => ({ source: p.uri, quote: p.quote, asserted_by: p.asserted_by })),
                })),
            });
        }),
    );

    server.registerTool(
        'confirm_claim',
        {
            title: 'Confirm claims',
            description:
                'Trusted writers only: confirm quarantined claims (they become active), or attest ' +
                'active ones (raises confidence). Accepts many ids at once for bulk review.',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            inputSchema: {
                claims: z.array(z.string()).min(1).max(500).describe('Claim uuids or external ids'),
            },
        },
        async (args) => runTool('confirm_claim', { n: args.claims.length }, async () => {
            const who = requireTrusted(identity);
            const ids = await Promise.all(args.claims.map(resolveClaimId));
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const { rows } = await client.query<{ id: string; was: string }>(`
                    UPDATE claims c SET
                        status = CASE WHEN c.status = 'quarantined' THEN 'active' ELSE c.status END,
                        confidence = least(0.95, coalesce(c.confidence, 0.7) + 0.05),
                        updated_at = now()
                    FROM (SELECT id, status AS was FROM claims WHERE id = ANY($1::uuid[]) FOR UPDATE) old
                    WHERE c.id = old.id AND c.status IN ('quarantined', 'active', 'disputed')
                    RETURNING c.id, old.was`, [ids]);
                for (const r of rows) {
                    await client.query(`
                        INSERT INTO audit_log (identity_id, token_id, action, target_kind, target_id, detail)
                        VALUES ($1, $2, $3, 'claim', $4, $5)`,
                        [who.id, who.tokenId ?? null, r.was === 'quarantined' ? 'claim.confirm' : 'claim.attest', r.id,
                            JSON.stringify({ was: r.was })]);
                }
                await client.query('COMMIT');
                const confirmed = rows.filter((r) => r.was === 'quarantined').length;
                return json({
                    confirmed, attested: rows.length - confirmed,
                    unchanged: ids.length - rows.length,
                    ...(ids.length > rows.length && { note: 'superseded and retired claims cannot be confirmed' }),
                });
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        }),
    );

    server.registerTool(
        'retire_claim',
        {
            title: 'Retire claim',
            description:
                'Close a claim: it is wrong, obsolete, or (from quarantine) not worth keeping. ' +
                'Nothing is deleted — the claim stays in history with the reason. Trusted writers, ' +
                'or the claim\'s owner.',
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
            inputSchema: {
                claims: z.array(z.string()).min(1).max(500).describe('Claim uuids or external ids'),
                reason: z.string().min(3).describe('Why; stored in the audit log'),
            },
        },
        async (args) => runTool('retire_claim', { n: args.claims.length, reason: args.reason }, async () => {
            const who = requireSubmit(identity);
            const ids = await Promise.all(args.claims.map(resolveClaimId));
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const { rows } = await client.query<{ id: string }>(`
                    UPDATE claims SET status = 'retired', retracted_at = now(), updated_at = now()
                    WHERE id = ANY($1::uuid[]) AND status <> 'retired'
                      AND ($2 OR owner_identity = $3)
                    RETURNING id`, [ids, who.trusted, who.username ?? who.id]);
                for (const r of rows) {
                    await client.query(`
                        INSERT INTO audit_log (identity_id, token_id, action, target_kind, target_id, detail)
                        VALUES ($1, $2, 'claim.retire', 'claim', $3, $4)`,
                        [who.id, who.tokenId ?? null, r.id, JSON.stringify({ reason: args.reason })]);
                }
                await client.query('COMMIT');
                return json({
                    retired: rows.length,
                    ...(rows.length < ids.length && { not_retired: ids.length - rows.length, note: 'already retired, or not yours' }),
                });
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        }),
    );
}

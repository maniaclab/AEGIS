#!/usr/bin/env node
/**
 * Eval harness: run the gold set against the live search path.
 *
 *   npm run eval -- --repo ../../../aegis-agents [--file owl/eval-gold.yaml]
 *                   [--min-recall 0.8] [--json report.json] [--verbose]
 *
 * Two scores, kept separate so it is clear which half regressed:
 *   retrieval — recall@k of the expected claims, plus the `must_flag` check: a claim
 *               listed there, if it comes back at all (current or history search), must
 *               carry a superseded/disputed/expired flag, never look settled.
 *   answer    — correctness of a composed answer. There is no answer composer until
 *               compose_brief (Phase 5), so this is reported as skipped, not as passing.
 *
 * Exits non-zero when mean recall is under --min-recall or any must_flag check fails, so
 * it can gate CI once the gold set lives somewhere CI can read.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { closePool, pool } from '../db/pool.js';
import { ALL_STATUSES, searchClaims } from '../db/search.js';
import { shapeClaims } from '../db/claims.js';
import { embed, embeddingsAvailable } from '../llm/embeddings.js';

interface Question { q: string; expect: string[]; must_flag?: string[]; answer?: string }
interface Gold { k: number; questions: Question[] }

const UNSETTLED = ['superseded', 'disputed', 'expired', 'retired', 'unconfirmed'];

const { values: args } = parseArgs({
    options: {
        repo: { type: 'string', default: process.env.OWL_SEED_REPO },
        file: { type: 'string', default: 'owl/eval-gold.yaml' },
        'min-recall': { type: 'string', default: '0' },
        json: { type: 'string' },
        verbose: { type: 'boolean', default: false },
    },
});

async function main(): Promise<void> {
    if (!args.repo) throw new Error('--repo (or OWL_SEED_REPO) is required: the aegis-agents checkout');
    const gold = YAML.parse(readFileSync(path.join(args.repo, args.file!), 'utf8')) as Gold;
    const k = gold.k ?? 5;

    const { rows } = await pool.query<{ id: string; external_id: string }>(
        'SELECT id, external_id FROM claims WHERE external_id IS NOT NULL');
    const ext = new Map(rows.map((r) => [r.id, r.external_id.replace(/^seed:/, '')]));
    if (!rows.length) throw new Error('no claims with external ids — run `npm run seed` first');

    const vectors = embeddingsAvailable() ? await embed(gold.questions.map((q) => q.q)) : null;
    const mode = vectors ? 'vector+lexical+entity' : 'lexical+entity (no OPENAI_API_KEY)';

    const results = [];
    for (const [i, q] of gold.questions.entries()) {
        const embedding = vectors?.[i] ?? null;
        const hits = await searchClaims(q.q, { limit: k, embedding });
        const got = hits.map((h) => ext.get(h.id) ?? h.id);
        const found = q.expect.filter((e) => got.includes(e));

        // must_flag: look in a history search too, where superseded claims are allowed back.
        const flagFailures: string[] = [];
        if (q.must_flag?.length) {
            const history = await searchClaims(q.q, { limit: k, embedding, statuses: ALL_STATUSES, at: null });
            const ids = [...new Set([...hits, ...history].map((h) => h.id))];
            for (const c of await shapeClaims(ids)) {
                const short = ext.get(c.id) ?? c.id;
                if (q.must_flag.includes(short) && !c.flags.some((f) => UNSETTLED.includes(f))) {
                    flagFailures.push(`${short} returned without a flag`);
                }
            }
        }
        results.push({
            q: q.q, expect: q.expect, got, recall: found.length / q.expect.length,
            first_expected_rank: got.findIndex((g) => q.expect.includes(g)) + 1 || null,
            flag_failures: flagFailures,
        });
    }

    const mean = results.reduce((s, r) => s + r.recall, 0) / results.length;
    const hitRate = results.filter((r) => r.recall > 0).length / results.length;
    const mrr = results.reduce((s, r) => s + (r.first_expected_rank ? 1 / r.first_expected_rank : 0), 0) / results.length;
    const flagFails = results.flatMap((r) => r.flag_failures);

    for (const r of results) {
        const mark = r.recall === 1 ? 'ok  ' : r.recall > 0 ? 'part' : 'MISS';
        if (args.verbose || r.recall < 1 || r.flag_failures.length) {
            console.log(`${mark} recall=${r.recall.toFixed(2)} expect=[${r.expect}] got=[${r.got}]  ${r.q}`);
            for (const f of r.flag_failures) console.log(`     FLAG ${f}`);
        }
    }
    console.log(
        `\nretrieval (${mode}, k=${k}, n=${results.length}): ` +
        `recall@${k}=${mean.toFixed(3)} hit@${k}=${hitRate.toFixed(3)} MRR=${mrr.toFixed(3)} ` +
        `must_flag failures=${flagFails.length}`,
    );
    console.log('answer correctness: skipped (no answer composer until compose_brief, Phase 5)');

    if (args.json) {
        writeFileSync(args.json, JSON.stringify({ mode, k, recall: mean, hit_rate: hitRate, mrr, results }, null, 2));
    }
    if (mean < Number(args['min-recall']) || flagFails.length) process.exitCode = 1;
}

main()
    .catch((err) => {
        console.error(`eval failed: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
    })
    .finally(() => closePool());

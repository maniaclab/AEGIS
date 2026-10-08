/**
 * Running a queued document job: analyze, then commit. Used by the worker.
 */
import type { Job } from '../db/jobs.js';
import { analyze, Analysis, loadSource, SourcePayload } from './ingest.js';
import { commit, Committer, CommitResult } from './commit.js';

export interface DocumentPayload {
    source: SourcePayload;
    committer: Committer;
}

export interface DocumentResult {
    summary: string;
    analysis: Omit<Analysis, 'parsed_text'>;
    commit: CommitResult;
}

export async function runDocumentJob(job: Job<DocumentPayload>): Promise<DocumentResult> {
    const source = await loadSource(job.payload.source);
    const { analysis, vectors } = await analyze(source);
    const committed = await commit(analysis, job.payload.committer, { vectors });
    const { parsed_text: _drop, ...stored } = analysis;
    return { summary: summarize(analysis, committed), analysis: stored, commit: committed };
}

/** "6 claims: 2 new, 3 already known, 1 related to an existing claim; 1 dropped". */
export function summarize(a: Analysis, c?: CommitResult): string {
    const n = (v: string) => a.claims.filter((x) => x.verdict === v).length;
    const parts = [`${n('new')} new`, `${n('duplicate')} already known`];
    if (n('related')) parts.push(`${n('related')} related to an existing claim`);
    let s = `${a.claims.length} claim${a.claims.length === 1 ? '' : 's'} extracted: ${parts.join(', ')}`;
    if (a.dropped.length) s += `; ${a.dropped.length} dropped`;
    if (c) {
        s += `. Committed ${c.created.length} as ${c.status}, added ${c.attested.length} citation(s) to existing claims`;
        if (c.skipped.length) s += `, skipped ${c.skipped.length}`;
        if (c.entities_created.length) s += `; new entities: ${c.entities_created.join(', ')}`;
    }
    return `${s}.`;
}

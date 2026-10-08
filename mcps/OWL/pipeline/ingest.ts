/**
 * The ingest pipeline up to (not including) commit:
 *
 *   prepare  — fetch/accept the original, hash it, store it in the blob store
 *   analyze  — parse, extract, resolve entities, check novelty
 *
 * analyze() returns a self-contained Analysis that is stored in the job row: for
 * submit_knowledge it is the preview the submitter confirms; for submit_document the
 * worker commits it straight away. Either way commit.ts needs nothing else.
 */
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { embed, embeddingsAvailable, toVectorLiteral } from '../llm/provider.js';
import { getBlob, putBlob, sha256 } from './blob.js';
import { parseConversation, parseText, ParsedDocument, toCodePoints, Turn } from './parse.js';
import { extract, PROMPT_VERSION, Dropped } from './extract.js';
import { resolveMention, Resolution } from './entities.js';
import { classify, neighbours, Neighbour, NOVELTY_VERSION, Relation } from './novelty.js';

const MAX_BYTES = 5 << 20;

export interface Source {
    /** Original bytes: the submitted text, the fetched URL body, or the transcript as JSON. */
    raw: Buffer;
    mediaType: string;
    sourceKind: string;
    uri: string;
    title: string | null;
    hash: string;
    blobRef: string | null;
}

export interface SourceInput {
    content?: string;
    turns?: Turn[];
    url?: string;
    uri?: string;
    title?: string;
    mediaType?: string;
    sourceKind?: string;
}

export async function prepare(input: SourceInput): Promise<Source> {
    let raw: Buffer;
    let mediaType = input.mediaType ?? 'text/markdown';
    let uri = input.uri;
    if (input.turns) {
        raw = Buffer.from(JSON.stringify(input.turns));
        mediaType = 'application/x-owl-conversation';
    } else if (input.url) {
        ({ raw, mediaType } = await fetchAllowed(input.url, input.mediaType));
        uri ??= input.url;
    } else if (input.content !== undefined) {
        raw = Buffer.from(input.content, 'utf8');
    } else {
        throw new Error('nothing to ingest: give content, a conversation or a url');
    }
    if (raw.length > MAX_BYTES) throw new Error(`document is ${raw.length} bytes; the limit is ${MAX_BYTES}`);
    if (!raw.length) throw new Error('document is empty');
    const hash = sha256(raw);
    return {
        raw,
        mediaType,
        sourceKind: input.turns ? 'conversation' : (input.sourceKind ?? 'document'),
        uri: uri ?? `submission:${hash.slice(0, 16)}`,
        title: input.title ?? null,
        hash,
        blobRef: await putBlob(raw, mediaType),
    };
}

async function fetchAllowed(url: string, mediaType?: string): Promise<{ raw: Buffer; mediaType: string }> {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('only https URLs can be fetched');
    if (!config.fetchAllowedHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) {
        throw new Error(`${u.hostname} is not on OWL_FETCH_ALLOWED_HOSTS (${config.fetchAllowedHosts.join(', ')})`);
    }
    const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
    const type = mediaType ?? (res.headers.get('content-type') ?? 'text/plain').split(';')[0].trim();
    const raw = Buffer.from(await res.arrayBuffer());
    return { raw, mediaType: type === 'text/plain' && /\.md$/i.test(u.pathname) ? 'text/markdown' : type };
}

export function parse(source: Source): ParsedDocument {
    if (source.mediaType === 'application/x-owl-conversation') {
        return parseConversation(JSON.parse(source.raw.toString('utf8')) as Turn[]);
    }
    return parseText(source.raw.toString('utf8'), source.mediaType);
}

/** Rebuild a Source from a stored job payload. */
export async function loadSource(p: SourcePayload): Promise<Source> {
    const raw = p.blobRef ? await getBlob(p.blobRef) : Buffer.from(p.inline ?? '', 'base64');
    return { ...p, raw };
}

export type SourcePayload = Omit<Source, 'raw'> & { inline?: string };

export function sourcePayload(s: Source): SourcePayload {
    const { raw, ...rest } = s;
    return s.blobRef ? rest : { ...rest, inline: raw.toString('base64') };
}

export interface AnalyzedClaim {
    idx: number;
    text: string;
    subject: Resolution | null;
    /** Code point span into the parsed text, and the original text of it. */
    predicate: string;
    /** Null when the model's subject could not name a system. */
    span: [number, number];
    quote: string;
    valid_from: string | null;
    valid_to: string | null;
    asserted_by: string | null;
    confidence: number;
    /**
     * new; duplicate (of `neighbour`: commit adds a citation instead of a claim); related
     * (refines or conflicts with `neighbour`: kept, and flagged for Phase 3).
     */
    verdict: 'new' | 'duplicate' | 'related';
    relation: Relation;
    /** The existing claim the relation is to; for `new`, the nearest one, if any. */
    neighbour: Neighbour | null;
}

export interface Analysis {
    prompt_version: string;
    novelty_version: string;
    model: string;
    parser_version: string;
    document: { hash: string; uri: string; title: string | null; source_kind: string; media_type: string; blob_ref: string | null };
    /** Parsed text, kept only when it differs from the original (it is what spans index). */
    parsed_text: string | null;
    claims: AnalyzedClaim[];
    dropped: Dropped[];
    novelty: 'model' | 'embedding' | 'exact text only';
    usage: { prompt_tokens: number; completion_tokens: number };
}

export async function analyze(source: Source): Promise<{ analysis: Analysis; vectors: Map<number, number[]> }> {
    const doc = parse(source);
    const ex = await extract(doc, source.sourceKind, source.title ?? undefined);

    const subjects = await Promise.all(ex.candidates.map((c) => resolveMention(c.subject, c.subject_kind)));
    const vectors = new Map<number, number[]>();
    const useEmbeddings = embeddingsAvailable() && ex.candidates.length > 0;
    if (useEmbeddings) {
        (await embed(ex.candidates.map((c) => c.text))).forEach((v, i) => vectors.set(i, v));
    }

    const near = await Promise.all(ex.candidates.map((c, i) => neighbours(c.text, vectors.get(i) ?? null)));
    const novelty = await classify(ex.candidates.map((c, i) => ({ text: c.text, subject: subjects[i]?.id ?? null })), near);

    const claims: AnalyzedClaim[] = [];
    for (const [i, c] of ex.candidates.entries()) {
        const subject = subjects[i];
        const { relation, neighbour } = novelty[i];
        const verdict = relation === 'new' ? 'new' : relation === 'duplicate' ? 'duplicate' : 'related';
        claims.push({
            idx: i,
            text: c.text,
            subject,
            predicate: c.predicate,
            span: [toCodePoints(doc.text, c.span[0]), toCodePoints(doc.text, c.span[1])],
            quote: c.quote,
            valid_from: c.valid_from,
            valid_to: c.valid_to,
            asserted_by: c.asserted_by,
            confidence: c.confidence,
            verdict,
            relation,
            neighbour,
        });
    }

    return {
        analysis: {
            prompt_version: PROMPT_VERSION,
            novelty_version: NOVELTY_VERSION,
            model: ex.model,
            parser_version: doc.parserVersion,
            document: {
                hash: source.hash, uri: source.uri, title: source.title,
                source_kind: source.sourceKind, media_type: source.mediaType, blob_ref: source.blobRef,
            },
            parsed_text: doc.text === source.raw.toString('utf8') ? null : doc.text,
            claims,
            dropped: ex.dropped,
            novelty: novelty.some((v) => v.by === 'model') ? 'model'
                : useEmbeddings ? 'embedding' : 'exact text only',
            usage: ex.usage,
        },
        vectors,
    };
}

/** Idempotency: same bytes, same prompt, same model, same submitter, same kind = same job. */
export function jobKey(source: Source, submitter: string): string {
    const model = config.extractionTier === 'cheap' ? config.cheap.model : config.strong.model;
    return sha256([source.hash, PROMPT_VERSION, NOVELTY_VERSION, model, submitter, source.sourceKind].join('|'));
}

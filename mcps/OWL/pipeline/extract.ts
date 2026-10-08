/**
 * Extraction: parsed text -> candidate claims, each tied to a verified span.
 *
 * The document is shown to the model with numbered lines, and each claim cites the line
 * range it comes from. Models cannot count characters and, it turned out, will not copy
 * quotes verbatim either — Nemotron paraphrased or invented about a third of its quotes
 * no matter how the prompt asked. Line numbers it copies reliably. The span is then those
 * lines of the original, so every citation is verbatim by construction.
 *
 * Only lines that may be cited carry a number: in a conversation, assistant turns are
 * shown without numbers, as context the model cannot cite (the conversation rule).
 *
 * PROMPT_VERSION is part of every job's idempotency key and of every provenance row's
 * extractor_version. Change the prompt, bump the version; `npm run reextract` replays.
 */
import { chat } from '../llm/provider.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import type { ParsedDocument } from './parse.js';

export const PROMPT_VERSION = 'extract-v2';

/** Characters per model call: small enough that the answer stays well within max_tokens. */
const CHUNK_CHARS = 6_000;
/** A claim may cite at most this many lines. */
const MAX_LINES = 6;

export interface KnownEntity { id: string; name: string; kind: string; aliases: string[] }

export interface RawClaim {
    line_start: number;
    line_end: number;
    subject: string;
    subject_kind: string;
    predicate: string;
    text: string;
    valid_from: string | null;
    valid_to: string | null;
    asserted_by: string | null;
    confidence: number;
}

export interface Candidate extends Omit<RawClaim, 'line_start' | 'line_end'> {
    /** UTF-16 span in the parsed text, and its original text. */
    span: [number, number];
    quote: string;
}

export interface Dropped { text: string; lines?: string; reason: string }

const SCHEMA = {
    name: 'owl_extraction',
    schema: {
        type: 'object',
        additionalProperties: false,
        required: ['claims'],
        properties: {
            claims: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    // Order matters: decoding follows it, so the model commits to the source
                    // lines and the subject before it writes the claim.
                    required: ['line_start', 'line_end', 'subject', 'subject_kind', 'predicate',
                        'text', 'valid_from', 'valid_to', 'asserted_by', 'confidence'],
                    properties: {
                        line_start: { type: 'integer' },
                        line_end: { type: 'integer' },
                        subject: { type: 'string' },
                        subject_kind: {
                            type: 'string',
                            enum: ['service', 'site', 'host', 'software', 'dataset', 'repository',
                                'procedure', 'organization', 'other'],
                        },
                        predicate: { type: 'string' },
                        text: { type: 'string' },
                        valid_from: { type: ['string', 'null'] },
                        valid_to: { type: ['string', 'null'] },
                        asserted_by: { type: ['string', 'null'] },
                        confidence: { type: 'number' },
                    },
                },
            },
        },
    },
};

const SYSTEM = `You extract knowledge for OWL, the curated knowledge base of ATLAS distributed computing (grid sites, PanDA, Rucio, FTS, CRIC, Frontier, monitoring, analysis facilities).

The document is given with numbered lines ("L12| ..."). Return the factual claims it states about systems — services, sites, hosts, software, datasets, repositories, procedures.

A claim is ONE atomic fact that is true on its own:
- Self-contained: name the system explicitly. Never "it", "this index", "the field" — say which.
- Atomic: one fact per claim; split lines that state several unrelated facts.
- Faithful: state only what the cited lines say. Do not add background knowledge.

Do NOT extract:
- instructions, rules or reminders addressed to an assistant or agent ("never do X", "always check Y", "ask before Z", which channel to post in, which baseline to report against)
- personal preferences, opinions, greetings, plans, to-dos, open questions
- the status of an ongoing incident or investigation, unless it states a lasting fact about a system
- facts about the document itself, its author, or the conversation
- credentials of any kind: tokens, API keys, passwords, secrets

Fields, in this order:
- line_start, line_end: the numbered lines that state the fact — usually one line, at most ${MAX_LINES}. Include a heading line only when the fact needs it to make sense. Only numbered lines can be cited.
- subject: the SYSTEM the fact is about: the id of a KNOWN ENTITY whenever one fits — check names and aliases, and prefer an existing entity over a new one. Otherwise a short canonical name of a system, site, service, software, dataset or repository (e.g. "PanDA pilot", "CSCS-LCG2", "jobs_archive table"). The subject is never a value (a port number, a version, a count), a field or parameter name, a region label, a person, or a generic word like "proxies", "port", "state" or "baseline" — for a fact about a field, the subject is the index, table or tool that has the field.
- subject_kind: what kind of thing the subject is.
- predicate: short snake_case name of the aspect (e.g. port, version, es_index, field_semantics, error_semantics, deployment, endpoint).
- text: the claim as one plain, complete sentence that names the system. It must make sense to someone who has not seen the document.
- valid_from / valid_to: ISO date (YYYY-MM-DD) only if the lines say when the fact became or stopped being true; otherwise null.
- asserted_by: the person the lines say stated or confirmed the fact; otherwise null.
- confidence: 0.9 when stated plainly, 0.6 when hedged or inferred from context.

Extract every qualifying fact; a long technical document can hold dozens. If nothing qualifies, return an empty list.`;

const KIND_NOTES: Record<string, string> = {
    'agent-memory':
        'This document is the long-term memory file of an AI agent. It mixes facts about systems with the ' +
        "agent's own rules, identity and working state." +
        ' Extract every fact about a system, including facts ' +
        'stated inside a rule (e.g. "use index X for Y data" states that index X holds Y data) and facts in ' +
        'tables or lists; skip only what says nothing about any system.',
    conversation:
        'This document is a conversation transcript. Only the user\'s lines are numbered: they are the ' +
        'assertions. Unnumbered lines are the assistant\'s, context only: never extract a claim that only ' +
        'the assistant makes.',
};

export async function knownEntities(): Promise<KnownEntity[]> {
    const { rows } = await pool.query<KnownEntity>(`
        SELECT e.id, e.name, e.kind,
               coalesce(array_agg(a.alias) FILTER (WHERE lower(a.alias) NOT IN (lower(e.id), lower(e.name))), '{}') AS aliases
        FROM entities e LEFT JOIN entity_aliases a ON a.entity_id = e.id
        WHERE NOT e.provisional
        GROUP BY e.id ORDER BY e.id
        LIMIT 400`);
    return rows;
}

interface Line { n: number; start: number; end: number; text: string; citable: boolean }

/** Lines with their UTF-16 offsets; a line is citable when it lies in an assertable range. */
function lines(doc: ParsedDocument): Line[] {
    const out: Line[] = [];
    let start = 0;
    for (const [i, text] of doc.text.split('\n').entries()) {
        const end = start + text.length;
        const citable = text.trim() !== ''
            && (!doc.assertable || doc.assertable.some(([a, b]) => start < b && end > a));
        out.push({ n: i + 1, start, end, text, citable });
        start = end + 1;
    }
    return out;
}

/** Consecutive runs of lines of at most CHUNK_CHARS, split at blank lines when possible. */
function chunks(all: Line[]): Line[][] {
    const out: Line[][] = [];
    let cur: Line[] = [];
    let size = 0;
    for (const l of all) {
        if (size + l.text.length > CHUNK_CHARS && cur.length) {
            let cut = cur.length;
            for (let i = cur.length - 1; i > cur.length / 2; i--) if (!cur[i].text.trim()) { cut = i + 1; break; }
            out.push(cur.slice(0, cut));
            cur = cur.slice(cut);
            size = cur.reduce((s, x) => s + x.text.length, 0);
        }
        cur.push(l);
        size += l.text.length;
    }
    if (cur.some((l) => l.text.trim())) out.push(cur);
    return out;
}

const render = (ls: Line[]) => ls
    .filter((l) => l.text.trim())
    .map((l) => (l.citable ? `L${l.n}| ${l.text}` : `    ${l.text}`))
    .join('\n');

const SECRET = [
    /\bbearer\s+[a-z0-9._~+/=-]{6,}/i,
    /\b(api[_-]?key|token|secret|password|passwd)\b\s*[:=]\s*\S{4,}/i,
    /\bsk-[a-z0-9_-]{20,}/i,
    /\bxox[abpr]-[a-z0-9-]{10,}/i,
    /\bgh[pousr]_[a-z0-9]{20,}/i,
    /\bAKIA[0-9A-Z]{16}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
export const looksSecret = (s: string) => SECRET.some((re) => re.test(s));

export interface Extraction {
    candidates: Candidate[];
    dropped: Dropped[];
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number };
}

export async function extract(doc: ParsedDocument, sourceKind: string, title?: string): Promise<Extraction> {
    const entities = await knownEntities();
    const entityList = entities.map((e) =>
        `- ${e.id} (${e.kind}): ${e.name}${e.aliases.length ? `; also ${e.aliases.join(', ')}` : ''}`).join('\n');
    const note = KIND_NOTES[doc.assertable ? 'conversation' : sourceKind] ?? '';
    const all = lines(doc);

    const candidates: Candidate[] = [];
    const dropped: Dropped[] = [];
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    const seen = new Set<string>();
    let model = '';

    for (const chunk of chunks(all)) {
        if (!chunk.some((l) => l.citable)) continue;
        // Reference material goes in the system prompt, the document alone in the user turn:
        // a small model otherwise "extracts" from the entity list.
        const reply = await chat<{ claims: RawClaim[] }>({
            tier: config.extractionTier,
            system: `${SYSTEM}\n\nKNOWN ENTITIES (reference for choosing subjects, not content):\n${entityList || '(none yet)'}`,
            user:
                (note ? `NOTE: ${note}\n\n` : '') +
                `DOCUMENT${title ? ` "${title}"` : ''}:\n${render(chunk)}`,
            schema: SCHEMA,
            maxTokens: 16_000,
        });
        model = reply.model;
        usage.prompt_tokens += reply.usage?.prompt_tokens ?? 0;
        usage.completion_tokens += reply.usage?.completion_tokens ?? 0;

        const inChunk = new Map(chunk.map((l) => [l.n, l]));
        for (const raw of reply.value.claims) {
            const text = raw.text.trim();
            if (!text) continue;
            const where = `L${raw.line_start}-${raw.line_end}`;
            const a = inChunk.get(raw.line_start);
            const b = inChunk.get(raw.line_end);
            if (!a || !b || b.n < a.n || b.n - a.n >= MAX_LINES) {
                dropped.push({ text, lines: where, reason: 'cites lines that are not in the document' });
                continue;
            }
            const cited = chunk.filter((l) => l.n >= a.n && l.n <= b.n);
            if (!cited.every((l) => l.citable || !l.text.trim())) {
                dropped.push({ text, lines: where, reason: 'cites an assistant turn' });
                continue;
            }
            // Trim the span to the text proper: no leading indentation, no trailing space.
            const start = a.start + (a.text.length - a.text.trimStart().length);
            const end = b.end - (b.text.length - b.text.trimEnd().length);
            const quote = doc.text.slice(start, end);
            if (looksSecret(text) || looksSecret(quote)) {
                dropped.push({ text: '(withheld)', lines: where, reason: 'looks like it contains a credential' });
                continue;
            }
            const key = text.toLowerCase().replace(/\W+/g, ' ');
            if (seen.has(key)) continue;
            seen.add(key);
            const { line_start: _s, line_end: _e, ...rest } = raw;
            candidates.push({
                ...rest,
                text,
                subject: raw.subject.trim(),
                predicate: raw.predicate.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
                valid_from: isoDate(raw.valid_from),
                valid_to: isoDate(raw.valid_to),
                asserted_by: raw.asserted_by?.trim() || null,
                confidence: Math.max(0, Math.min(1, raw.confidence)),
                span: [start, end],
                quote,
            });
        }
    }
    const kept = await keepFacts(candidates, dropped, usage);
    return { candidates: kept, dropped, model, usage };
}

const STATEMENT_SCHEMA = {
    name: 'owl_statement_types',
    schema: {
        type: 'object',
        additionalProperties: false,
        required: ['labels'],
        properties: {
            labels: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['i', 'statement'],
                    properties: {
                        i: { type: 'integer' },
                        statement: { type: 'string', enum: ['fact', 'instruction', 'preference', 'incident_status'] },
                    },
                },
            },
        },
    },
};

const STATEMENT_SYSTEM = `Label each numbered sentence.

- fact: describes how a system is or behaves — what an index contains, what a field means, which port a service uses, what a tool returns, how an error is handled, where something is deployed. A fact phrased with "should" or "use" is still a fact when it describes the system (e.g. "the field to use for task priority is currentpriority").
- instruction: a rule or policy for an assistant or a team — which baseline to report against, which channel to post in, what not to do without approval, which tool to prefer.
- preference: what a person likes or wants.
- incident_status: the state or numbers of a specific ongoing problem (error counts, outages, ticket status).`;

/**
 * Drop candidates that are not facts about systems. A separate pass, on the claims alone:
 * asked inside extraction, with the document in view, a small model labelled almost every
 * line of an agent's memory as an instruction. On isolated sentences it does not.
 */
async function keepFacts(
    candidates: Candidate[],
    dropped: Dropped[],
    usage: { prompt_tokens: number; completion_tokens: number },
): Promise<Candidate[]> {
    if (!candidates.length) return candidates;
    const label = new Map<number, string>();
    for (let from = 0; from < candidates.length; from += 60) {
        const batch = candidates.slice(from, from + 60);
        const reply = await chat<{ labels: { i: number; statement: string }[] }>({
            tier: config.extractionTier,
            system: STATEMENT_SYSTEM,
            user: batch.map((c, k) => `${from + k}. ${c.text}`).join('\n'),
            schema: STATEMENT_SCHEMA,
        });
        usage.prompt_tokens += reply.usage?.prompt_tokens ?? 0;
        usage.completion_tokens += reply.usage?.completion_tokens ?? 0;
        for (const l of reply.value.labels) label.set(l.i, l.statement);
    }
    return candidates.filter((c, i) => {
        const kind = label.get(i) ?? 'fact'; // unlabelled: keep, quarantine review decides
        if (kind !== 'fact') dropped.push({ text: c.text, reason: `not a fact about a system (${kind})` });
        return kind === 'fact';
    });
}

function isoDate(s: string | null): string | null {
    if (!s) return null;
    const m = s.match(/^\d{4}-\d{2}-\d{2}/);
    return m && !Number.isNaN(Date.parse(m[0])) ? m[0] : null;
}

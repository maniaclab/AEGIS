/**
 * Embeddings, via any OpenAI-compatible /embeddings endpoint.
 *
 * Phase 2 folds this into the provider abstraction next to chat(); until then it is the
 * only model call OWL makes. The dimension is requested explicitly so a provider default
 * can never disagree with the column type.
 */
import { config } from '../config.js';
import { logUpstream } from '../logger.js';

/** OpenAI accepts up to 2048 inputs per request; stay well under it. */
const BATCH = 256;

export function embeddingsAvailable(): boolean {
    return !!config.openaiApiKey;
}

/** Model and dimension default to the configured ones; `npm run reembed` overrides both. */
export interface EmbedOptions { model?: string; dimensions?: number }

export async function embed(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
    if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
        out.push(...await embedBatch(texts.slice(i, i + BATCH), opts));
    }
    return out;
}

async function embedBatch(input: string[], opts: EmbedOptions): Promise<number[][]> {
    const url = `${config.embedding.baseUrl.replace(/\/$/, '')}/embeddings`;
    const started = process.hrtime.bigint();
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.openaiApiKey}`,
        },
        body: JSON.stringify({
            model: opts.model ?? config.embedding.model,
            dimensions: opts.dimensions ?? config.embedding.dimensions,
            input,
        }),
        signal: AbortSignal.timeout(60_000),
    });
    logUpstream('embeddings', 'POST', '/embeddings', res.status, started);
    if (!res.ok) {
        throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = await res.json() as { data: { index: number; embedding: number[] }[] };
    return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/** pgvector's text form; cast with ::halfvec in SQL. */
export function toVectorLiteral(v: number[]): string {
    return `[${v.join(',')}]`;
}

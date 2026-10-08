/**
 * The provider abstraction: structured chat on two tiers, plus embeddings.
 *
 * Both tiers speak the OpenAI chat-completions dialect — vLLM on the Sparks for `cheap`,
 * the hosted API for `strong` — so switching either side is a config change. Output is
 * constrained to a JSON schema (vLLM guided decoding; OpenAI structured outputs), so the
 * caller gets a parsed object, never free text to scrape.
 */
import { config } from '../config.js';
import { logUpstream } from '../logger.js';

export type Tier = 'cheap' | 'strong';

export interface ChatRequest {
    tier: Tier;
    system: string;
    user: string;
    /** JSON schema of the reply; `name` is required by the OpenAI API. */
    schema: { name: string; schema: object };
    maxTokens?: number;
    timeoutMs?: number;
}

export interface ChatResult<T> {
    value: T;
    /** `<base>#<model>`: recorded with every extraction, part of the job idempotency key. */
    model: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
}

export function modelId(tier: Tier): string {
    return tier === 'cheap' ? config.cheap.model : config.strong.model;
}

export async function chat<T>(req: ChatRequest): Promise<ChatResult<T>> {
    const target = req.tier === 'cheap' ? config.cheap : config.strong;
    if (!target.baseUrl) throw new Error(`no endpoint configured for the ${req.tier} model`);
    const key = req.tier === 'strong' ? config.openaiApiKey : undefined;
    const url = `${target.baseUrl.replace(/\/$/, '')}/chat/completions`;

    const body: Record<string, unknown> = {
        model: target.model,
        messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
        ],
        response_format: { type: 'json_schema', json_schema: { ...req.schema, strict: true } },
    };
    // OpenAI's reasoning models take max_completion_tokens; vLLM takes max_tokens.
    body[req.tier === 'strong' ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens ?? 8000;
    if (req.tier === 'cheap') {
        // vLLM: deterministic. With thinking on, vLLM's reasoning parser keeps the reasoning out
        // of `content` and guided decoding applies to the answer only.
        body.temperature = 0;
        body.chat_template_kwargs = { enable_thinking: config.cheap.thinking };
    }

    const started = process.hrtime.bigint();
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key && { Authorization: `Bearer ${key}` }) },
        body: JSON.stringify(body),
        // Generous: a reasoning model can think for minutes over a long chunk.
        signal: AbortSignal.timeout(req.timeoutMs ?? 900_000),
    });
    logUpstream(req.tier === 'cheap' ? 'vllm' : 'llm', 'POST', '/chat/completions', res.status, started);
    if (!res.ok) throw new Error(`${req.tier} model ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const reply = await res.json() as {
        choices: { message: { content: string | null }; finish_reason: string }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const choice = reply.choices[0];
    if (choice.finish_reason === 'length') throw new Error(`${req.tier} model ran out of tokens`);
    const content = choice.message.content ?? '';
    try {
        return { value: JSON.parse(content) as T, model: `${req.tier}#${target.model}`, usage: reply.usage };
    } catch {
        throw new Error(`${req.tier} model returned invalid JSON: ${content.slice(0, 200)}`);
    }
}

export { embed, embeddingsAvailable, toVectorLiteral } from './embeddings.js';

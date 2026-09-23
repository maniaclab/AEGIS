import { Request, Response, NextFunction } from 'express';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = typeof LEVELS[number];

const threshold = LEVELS.indexOf((process.env.LOG_LEVEL as Level) ?? 'info');
const minLevel = threshold === -1 ? LEVELS.indexOf('info') : threshold;

function emit(level: Level, message: string): void {
    if (LEVELS.indexOf(level) < minLevel) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
    if (level === 'warn' || level === 'error') console.error(line);
    else console.log(line);
}

export const log = {
    debug: (message: string) => emit('debug', message),
    info: (message: string) => emit('info', message),
    warn: (message: string) => emit('warn', message),
    error: (message: string) => emit('error', message),
};

/** Describe the JSON-RPC payload of an MCP request, e.g. `mcp=tools/call tool=get_claim`. */
function describeRpc(body: unknown): string {
    const calls = Array.isArray(body) ? body : [body];
    const parts = calls
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .map((c) => {
            const params = (c.params ?? {}) as Record<string, unknown>;
            const tool = typeof params.name === 'string' ? ` tool=${params.name}` : '';
            return `mcp=${c.method ?? '?'}${tool}`;
        });
    return parts.join(' ');
}

let requestCounter = 0;

/**
 * Logs one timestamped line when a request arrives and another when the response
 * finishes, correlated by request id. Set LOG_LEVEL=debug to also dump bodies.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
    const id = ++requestCounter;
    const started = process.hrtime.bigint();
    const ip = req.ip ?? req.socket.remoteAddress ?? '-';
    const rpc = describeRpc(req.body);

    log.info(`req#${id} --> ${req.method} ${req.originalUrl} ip=${ip}${rpc ? ' ' + rpc : ''}`);
    if (req.body !== undefined) log.debug(`req#${id} body=${JSON.stringify(req.body)}`);

    res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const who = req.owlIdentity ? ` who=${req.owlIdentity.id}` : '';
        const line = `req#${id} <-- ${res.statusCode} ${ms.toFixed(1)}ms${who}`;
        if (res.statusCode >= 500) log.error(line);
        else if (res.statusCode >= 400) log.warn(line);
        else log.info(line);
    });

    // Fires when the client disconnects before the response completed.
    res.on('close', () => {
        if (res.writableFinished) return;
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        log.warn(`req#${id} <-- aborted by client after ${ms.toFixed(1)}ms`);
    });

    next();
}

/** Log an outbound call to an upstream service (vLLM, OpenAI, S3, CRIC, ...). */
export function logUpstream(
    system: string,
    method: string,
    path: string,
    status: number,
    startedAt: bigint,
): void {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const line = `${system} ${method} ${path} ${status} ${ms.toFixed(1)}ms`;
    if (status >= 400) log.warn(line);
    else log.info(line);
}

/**
 * Run a tool handler, logging the invocation, its arguments, duration and outcome.
 * Errors are reported to the caller as tool text, matching MCP conventions.
 */
export async function runTool(
    tool: string,
    args: unknown,
    handler: () => Promise<string>,
): Promise<{ content: { type: "text"; text: string }[] }> {
    const started = process.hrtime.bigint();
    try {
        const text = await handler();
        logTool(tool, args, true, started);
        return { content: [{ type: "text" as const, text }] };
    } catch (err) {
        logTool(tool, args, false, started, `err=${err}`);
        return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
}

function logTool(tool: string, args: unknown, ok: boolean, startedAt: bigint, detail?: string): void {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const line = `tool ${tool} ${ok ? 'ok' : 'error'} ${ms.toFixed(1)}ms args=${JSON.stringify(args)}${detail ? ` ${detail}` : ''}`;
    if (ok) log.info(line);
    else log.error(line);
}

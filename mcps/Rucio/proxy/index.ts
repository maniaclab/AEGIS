#!/usr/bin/env node
/**
 * Auth front for the upstream rucio-mcp server, which only understands one shared secret.
 *
 * Accepts the same credentials as the other AF MCPs (Keycloak tokens, AF API keys) plus the
 * legacy Rucio shared secret, then forwards the request to rucio-mcp on localhost with the
 * shared secret swapped in. Responses, including SSE streams, are piped back unchanged.
 */
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import http from 'node:http';
import { protectedResourceMetadata, requireApiKey } from './authMiddleware.js';
import { log, requestLogger } from './logger.js';

import dotenv from 'dotenv';
dotenv.config();

const PORT = Number(process.env.PORT ?? 8000);
const upstream = new URL(process.env.UPSTREAM_URL ?? 'http://127.0.0.1:8001/site/atlas/');
const sharedSecret = process.env.RUCIO_MCP_TOKEN;
if (!sharedSecret) throw new Error('RUCIO_MCP_TOKEN environment variable is not set');

// Hop-by-hop headers, plus the ones replaced here: the caller's credential must never
// reach rucio-mcp, and its DNS-rebinding guard checks Host and Origin.
const DROP_REQUEST_HEADERS = new Set([
    'host', 'authorization', 'origin', 'content-length', 'connection', 'keep-alive',
    'transfer-encoding', 'upgrade', 'proxy-authorization', 'te', 'trailer',
]);
const DROP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'trailer']);

/** The legacy shared secret keeps working for clients configured before the proxy existed. */
function acceptSharedSecret(req: Request, res: Response, next: NextFunction): void {
    const token = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1].trim();
    if (token === sharedSecret) return next();
    void requireApiKey(req, res, next);
}

function forward(req: Request, res: Response): void {
    const body = (req as Request & { rawBody?: Buffer }).rawBody;
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
        if (!DROP_REQUEST_HEADERS.has(name) && value !== undefined) headers[name] = value;
    }
    headers.host = upstream.host;
    headers.authorization = `Bearer ${sharedSecret}`;
    if (body?.length) headers['content-length'] = body.length;

    const started = process.hrtime.bigint();
    const upstreamReq = http.request(
        { hostname: upstream.hostname, port: upstream.port, path: upstream.pathname, method: req.method, headers },
        (upstreamRes) => {
            const ms = (Number(process.hrtime.bigint() - started) / 1e6).toFixed(1);
            const line = `rucio-mcp ${req.method} ${upstream.pathname} ${upstreamRes.statusCode} ${ms}ms`;
            if ((upstreamRes.statusCode ?? 500) >= 400) log.warn(line);
            else log.info(line);

            for (const [name, value] of Object.entries(upstreamRes.headers)) {
                if (!DROP_RESPONSE_HEADERS.has(name) && value !== undefined) res.setHeader(name, value);
            }
            res.status(upstreamRes.statusCode ?? 502);
            // An idle SSE stream sends no bytes, so send headers now rather than on first event.
            res.flushHeaders();
            upstreamRes.pipe(res);
        },
    );
    upstreamReq.on('error', (err) => {
        log.error(`rucio-mcp unreachable: ${err.message}`);
        if (!res.headersSent) res.status(502).json({ error: 'Rucio MCP upstream unavailable' });
        else res.end();
    });
    // Stop upstream work, e.g. an open SSE stream, when the client goes away.
    res.on('close', () => upstreamReq.destroy());
    upstreamReq.end(body?.length ? body : undefined);
}

const app = express();
app.use(cors({
    allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID'],
    exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'],
}));

// Keep the exact bytes for forwarding, but expose parsed JSON so the request log can name the tool.
app.use(express.raw({ type: () => true, limit: process.env.MAX_BODY ?? '8mb' }));
app.use((req: Request, _res: Response, next: NextFunction) => {
    const raw = req.body as Buffer | undefined;
    (req as Request & { rawBody?: Buffer }).rawBody = raw;
    try {
        req.body = raw?.length ? JSON.parse(raw.toString('utf8')) : undefined;
    } catch {
        req.body = undefined;
    }
    next();
});
app.use(requestLogger);

app.get('/healthz', (_req: Request, res: Response) => { res.json({ ok: true }); });
app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata);

// /mcp is the canonical endpoint; /site/atlas stays for clients set up against rucio-mcp directly.
app.all(['/mcp', '/site/atlas', '/site/atlas/'], acceptSharedSecret, forward);

app.listen(PORT, () => {
    log.info(`Rucio MCP auth proxy listening on port ${PORT}, forwarding to ${upstream.href}`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

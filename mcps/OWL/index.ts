#!/usr/bin/env node
/**
 * owl-mcp — the HTTP/MCP front end of the librarian.
 *
 * Stateless: it reads and writes Postgres and enqueues work for owl-worker, so it scales
 * horizontally. Same transport and middleware shape as the other AF MCP servers.
 */
import express, { Request, Response } from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { requireIdentity } from './authMiddleware.js';
import { log, requestLogger } from './logger.js';
import { blobBackend, config } from './config.js';
import { closePool, dbStatus } from './db/pool.js';
import { registerStatusTool } from './tools/status.js';
import type { Identity } from './identity.js';

// @ts-expect-error ignore `with` keyword
import pkg from './package.json' with { type: 'json' }

const product = {
    name: pkg.name,
    version: pkg.version,
};

/**
 * A fresh server per request, carrying the caller's identity.
 *
 * Tools need to know who is asking — provenance and quarantine depend on it — and the
 * transport is created per request anyway, so there is no shared instance to leak identity
 * between callers.
 */
export async function createOwlMcpServer(identity?: Identity): Promise<McpServer> {
    const server = new McpServer(product);
    registerStatusTool(server, identity);
    return server;
}

const app = express();
app.use(cors({
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: process.env.OWL_MAX_BODY ?? '8mb' }));
app.use(requestLogger);

/** Unauthenticated, for kubelet probes. Reports process liveness, not database health. */
app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, name: product.name, version: product.version });
});

/** Authenticated readiness detail, for humans debugging a deployment. */
app.get('/readyz', requireIdentity, async (_req: Request, res: Response) => {
    const db = await dbStatus();
    res.status(db.reachable ? 200 : 503).json(db);
});

app.post('/mcp', requireIdentity, async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    });
    const server = await createOwlMcpServer(req.owlIdentity);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
});

const server = app.listen(config.port, () => {
    log.info(`OWL MCP Streamable HTTP Server listening on port ${config.port}`);
    log.info(
        `config: blob=${blobBackend()} cheap=${config.cheap.model} ` +
        `strong=${config.strong.model} embedding=${config.embedding.model}/${config.embedding.dimensions}d ` +
        `trusted_writers=${config.trustedWriters.length}`,
    );
    if (config.trustedWriters.length === 0) {
        log.warn('OWL_TRUSTED_WRITERS is empty — every submission will be quarantined');
    }
});

async function shutdown(signal: string): Promise<void> {
    log.info(`${signal} received, shutting down...`);
    server.close();
    await closePool();
    process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

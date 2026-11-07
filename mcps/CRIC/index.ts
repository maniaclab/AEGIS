#!/usr/bin/env node
import express, { Request, Response } from 'express';
import { protectedResourceMetadata, requireApiKey } from './authMiddleware.js';
import { log, logUpstream, requestLogger, withToolLog } from './logger.js';

import cors from 'cors';
import dns from 'dns';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import tls from 'tls';

import { z } from 'zod';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import dotenv from 'dotenv';
dotenv.config();

// @ts-expect-error ignore `with` keyword
import pkg from './package.json' with { type: 'json' }

const product = {
    name: pkg.name,
    version: pkg.version,
};

// Sent to clients at initialize: how to use these tools together.
const instructions = [
    "Read-only access to ATLAS site and queue configuration in CRIC, plus authenticated fetches of the URLs it lists.",
    "Tools: list_rc_sites (sites), list_panda_queues and list_queue_statuses (PanDA queues and their state), list_panda_queue_tags, list_ddm_endpoints and list_ddm_endpoint_statuses (storage endpoints), fetch_x509_url (GET a URL with the service's grid x509 proxy).",
    "All filters are optional, but pass one where you can: unfiltered lists are large.",
    "Names are CRIC names: an RC site (e.g. MWT2) owns PanDA queues and DDM endpoints, which have their own names (e.g. MWT2_UCORE, MWT2_DATADISK).",
    "For storage space usage, get the endpoint with list_ddm_endpoints and pass its info_url (or space_usage_url) to fetch_x509_url; the result is a JSON storage resource report (SRR) with total and used sizes in bytes.",
    "For FTS, take the server from the endpoint's servedrestfts (e.g. https://fts3-atlas.cern.ch:8446) and fetch_x509_url its REST paths, e.g. /whoami or /config/....",
    "fetch_x509_url returns at most max_bytes (default 1 MB) and refuses private or cluster-internal addresses.",
].join(" ");

// ---- fetch_x509_url helpers ----

// Addresses the fetch tool must never connect to: the URL comes from the caller, so without
// this it could reach services inside the cluster network.
const blockedAddresses = new net.BlockList();
for (const [addr, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedAddresses.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
    ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96],
] as const) blockedAddresses.addSubnet(addr, prefix, 'ipv6');

function isBlockedAddress(address: string): boolean {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blockedAddresses.check(mapped[1], 'ipv4');
    return blockedAddresses.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4');
}

// DNS lookup used for the actual connection, so the check cannot be bypassed by DNS rebinding.
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return (callback as Function)(err);
        const list = addresses as dns.LookupAddress[];
        const bad = list.find(a => isBlockedAddress(a.address));
        if (bad || list.length === 0) {
            const e = Object.assign(new Error(`Refusing to connect to ${hostname} (${bad?.address ?? 'no address'}): private or reserved address`), { code: 'EBLOCKED' });
            return (callback as Function)(e);
        }
        if ((options as dns.LookupOptions).all) return (callback as Function)(null, list);
        (callback as Function)(null, list[0].address, list[0].family);
    });
};

let x509AgentCache: { agent: https.Agent; mtimeMs: number } | undefined;

// HTTPS agent presenting the grid proxy, trusting both public and IGTF (grid) CAs.
// Rebuilt whenever the proxy file is renewed.
function getX509Agent(): https.Agent {
    const proxyPath = process.env.X509_USER_PROXY;
    const certDir = process.env.X509_CERT_DIR;
    if (!proxyPath || !certDir) throw new Error("X509_USER_PROXY or X509_CERT_DIR environment variables not set");
    const mtimeMs = fs.statSync(proxyPath).mtimeMs;
    if (x509AgentCache && x509AgentCache.mtimeMs === mtimeMs) return x509AgentCache.agent;
    const proxyPem = fs.readFileSync(proxyPath);
    const gridCAs = fs.readdirSync(certDir)
        .filter(f => f.endsWith('.pem') || f.endsWith('.crt'))
        .map(f => fs.readFileSync(path.join(certDir, f), 'utf8'));
    x509AgentCache?.agent.destroy();
    const agent = new https.Agent({
        cert: proxyPem,
        key: proxyPem,
        ca: [...tls.rootCertificates, ...gridCAs],
        rejectUnauthorized: true,
        lookup: safeLookup,
    });
    x509AgentCache = { agent, mtimeMs };
    return agent;
}

const plainHttpAgent = new http.Agent({ lookup: safeLookup });

type FetchResult = { url: string; status: number; contentType: string; body: string; truncated: boolean };

function fetchOnce(url: URL, maxBytes: number, timeoutMs: number): Promise<FetchResult & { location?: string }> {
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const agent = isHttps ? getX509Agent() : plainHttpAgent;
    const started = process.hrtime.bigint();
    return new Promise((resolve, reject) => {
        const req = mod.get(url, { agent, headers: { Accept: 'application/json, */*;q=0.8', 'User-Agent': `${product.name}/${product.version}` } }, (res) => {
            const status = res.statusCode ?? 0;
            logUpstream(url.host, 'GET', url.pathname, status, started);
            const location = res.headers.location;
            if (status >= 300 && status < 400 && location) {
                res.resume();
                return resolve({ url: url.toString(), status, contentType: '', body: '', truncated: false, location });
            }
            const chunks: Buffer[] = [];
            let size = 0;
            let truncated = false;
            res.on('data', (chunk: Buffer) => {
                if (truncated) return;
                if (size + chunk.length > maxBytes) {
                    chunks.push(chunk.subarray(0, maxBytes - size));
                    size = maxBytes;
                    truncated = true;
                    res.destroy();
                    finish();
                    return;
                }
                chunks.push(chunk);
                size += chunk.length;
            });
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                resolve({
                    url: url.toString(), status, truncated,
                    contentType: String(res.headers['content-type'] ?? ''),
                    body: Buffer.concat(chunks).toString('utf8'),
                });
            };
            res.on('end', finish);
            res.on('error', (err) => truncated ? finish() : reject(err));
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out after ${timeoutMs} ms`)));
        req.on('error', reject);
    });
}

function normalizeFetchUrl(raw: string, base?: URL): URL {
    const url = new URL(raw, base);
    // davs/https are the same thing on the wire for a GET (WebDAV over TLS).
    if (url.protocol === 'davs:') return new URL('https:' + url.href.slice('davs:'.length));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(`Unsupported scheme '${url.protocol}': only https, davs and http are allowed`);
    }
    if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed");
    // Node skips the lookup for IP literals, so safeLookup never sees them: check here.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isBlockedAddress(host)) {
        throw new Error(`Refusing to connect to ${host}: private or reserved address`);
    }
    return url;
}

async function fetchWithX509(raw: string, maxBytes: number, timeoutMs: number): Promise<FetchResult> {
    let url = normalizeFetchUrl(raw);
    for (let hop = 0; hop <= 5; hop++) {
        const r = await fetchOnce(url, maxBytes, timeoutMs);
        if (!r.location) return r;
        url = normalizeFetchUrl(r.location, url);
    }
    throw new Error("Too many redirects");
}


export async function createCricMcpServer(): Promise<McpServer> {

    const server = new McpServer(product, { instructions });

    server.registerTool(
        "list_rc_sites",
        {
            title: "List RC Sites",
            description: "List ATLAS RC sites from CRIC, optionally filtered by name, status, or state.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                name: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by RC site name (e.g. 'AGLT2')."),
                status: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by site status (e.g. 'online', 'offline')."),
                state: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by site state (e.g. 'ACTIVE')."),
            }
        },
        async ({ name, status, state }) => withToolLog("list_rc_sites", { name, status, state }, async () => {
            const proxyPath = process.env.X509_USER_PROXY;
            const certDir = process.env.X509_CERT_DIR;

            if (!proxyPath || !certDir) {
                return {
                    content: [{
                        type: "text" as const,
                        text: "Error: X509_USER_PROXY or X509_CERT_DIR environment variables not set",
                    }],
                    isError: true,
                };
            }

            let proxyPem: Buffer;
            let caCerts: Buffer[];
            try {
                proxyPem = fs.readFileSync(proxyPath);
                caCerts = fs.readdirSync(certDir)
                    .filter(f => f.endsWith('.pem') || f.endsWith('.crt'))
                    .map(f => fs.readFileSync(path.join(certDir, f)));
            } catch (err) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error reading certificate files: ${err}`,
                    }],
                    isError: true,
                };
            }

            const agent = new https.Agent({
                cert: proxyPem,
                key: proxyPem,
                ca: caCerts,
                rejectUnauthorized: true,
            });

            const params = new URLSearchParams({ json: '' });
            if (name) params.set('name', name);
            if (status) params.set('status', status);
            if (state) params.set('state', state);
            const url = `https://atlas-cric.cern.ch/api/core/rcsite/query/?${params}`;

            const started = process.hrtime.bigint();
            const data = await new Promise<string>((resolve, reject) => {
                https.get(
                    url,
                    { agent },
                    (res) => {
                        let body = '';
                        res.on('data', (chunk: string) => body += chunk);
                        res.on('end', () => {
                            logUpstream('cric', 'GET', new URL(url).pathname, res.statusCode ?? 0, started);
                            resolve(body);
                        });
                    }
                ).on('error', reject);
            });

            return {
                content: [{
                    type: "text" as const,
                    text: data,
                }],
            };
        })
    );

    server.registerTool(
        "list_queue_statuses",
        {
            title: "List Queue Statuses",
            description: "List ATLAS PanDA queue statuses from CRIC, optionally filtered by queue name or queue state.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                pandaqueue: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by PanDA queue name (e.g. 'AGLT2_ATLAS_INSTALL')."),
                state: z
                    .enum(['ACTIVE', 'INACTIVE', 'DISABLED', 'DELETED', 'ANY'])
                    .optional()
                    .describe("Filter queues by state."),
                status: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by queue status value (e.g. 'TEST', 'ONLINE', 'OFFLINE')."),
            }
        },
        async ({ pandaqueue, state, status }) => withToolLog("list_queue_statuses", { pandaqueue, state, status }, async () => {
            const proxyPath = process.env.X509_USER_PROXY;
            const certDir = process.env.X509_CERT_DIR;

            if (!proxyPath || !certDir) {
                return {
                    content: [{
                        type: "text" as const,
                        text: "Error: X509_USER_PROXY or X509_CERT_DIR environment variables not set",
                    }],
                    isError: true,
                };
            }

            let proxyPem: Buffer;
            let caCerts: Buffer[];
            try {
                proxyPem = fs.readFileSync(proxyPath);
                caCerts = fs.readdirSync(certDir)
                    .filter(f => f.endsWith('.pem') || f.endsWith('.crt'))
                    .map(f => fs.readFileSync(path.join(certDir, f)));
            } catch (err) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error reading certificate files: ${err}`,
                    }],
                    isError: true,
                };
            }

            const agent = new https.Agent({
                cert: proxyPem,
                key: proxyPem,
                ca: caCerts,
                rejectUnauthorized: true,
            });

            const params = new URLSearchParams({ json: '' });
            if (pandaqueue) params.set('pandaqueue', pandaqueue);
            if (state) params.set('state', state);
            if (status) params.set('value', status);
            const url = `https://atlas-cric.cern.ch/api/atlas/pandaqueuestatus/query/?${params}`;

            const started = process.hrtime.bigint();
            const data = await new Promise<string>((resolve, reject) => {
                https.get(
                    url,
                    { agent },
                    (res) => {
                        let body = '';
                        res.on('data', (chunk: string) => body += chunk);
                        res.on('end', () => {
                            logUpstream('cric', 'GET', new URL(url).pathname, res.statusCode ?? 0, started);
                            resolve(body);
                        });
                    }
                ).on('error', reject);
            });

            return {
                content: [{
                    type: "text" as const,
                    text: data,
                }],
            };
        })
    );

    server.registerTool(
        "list_ddm_endpoint_statuses",
        {
            title: "List DDM Endpoint Statuses",
            description: "List ATLAS DDM endpoint statuses from CRIC, optionally filtered by endpoint name or endpoint state ('ACTIVE', 'INACTIVE', 'DISABLED', 'DELETED', 'ANY').",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                ddmendpoint: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by DDM endpoint name (e.g. 'AGLT2_DATADISK')."),
                state: z
                    .enum(['ACTIVE', 'INACTIVE', 'DISABLED', 'DELETED', 'ANY'])
                    .optional()
                    .describe("Filter endpoints by state."),
            }
        },
        async ({ ddmendpoint, state }) => withToolLog("list_ddm_endpoint_statuses", { ddmendpoint, state }, async () => {
            const proxyPath = process.env.X509_USER_PROXY;
            const certDir = process.env.X509_CERT_DIR;

            if (!proxyPath || !certDir) {
                return {
                    content: [{
                        type: "text" as const,
                        text: "Error: X509_USER_PROXY or X509_CERT_DIR environment variables not set",
                    }],
                    isError: true,
                };
            }

            let proxyPem: Buffer;
            let caCerts: Buffer[];
            try {
                proxyPem = fs.readFileSync(proxyPath);
                caCerts = fs.readdirSync(certDir)
                    .filter(f => f.endsWith('.pem') || f.endsWith('.crt'))
                    .map(f => fs.readFileSync(path.join(certDir, f)));
            } catch (err) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error reading certificate files: ${err}`,
                    }],
                    isError: true,
                };
            }

            const agent = new https.Agent({
                cert: proxyPem,
                key: proxyPem,
                ca: caCerts,
                rejectUnauthorized: true,
            });

            const params = new URLSearchParams({ json: '' });
            if (ddmendpoint) params.set('ddmendpoint', ddmendpoint);
            if (state) params.set('state', state);
            const url = `https://atlas-cric.cern.ch/api/atlas/ddmendpointstatus/query/?${params}`;

            const started = process.hrtime.bigint();
            const data = await new Promise<string>((resolve, reject) => {
                https.get(
                    url,
                    { agent },
                    (res) => {
                        let body = '';
                        res.on('data', (chunk: string) => body += chunk);
                        res.on('end', () => {
                            logUpstream('cric', 'GET', new URL(url).pathname, res.statusCode ?? 0, started);
                            resolve(body);
                        });
                    }
                ).on('error', reject);
            });

            return {
                content: [{
                    type: "text" as const,
                    text: data,
                }],
            };
        })
    );

    server.registerTool(
        "list_ddm_endpoints",
        {
            title: "List DDM Endpoints",
            description: "List ATLAS DDM (storage) endpoints from CRIC, optionally filtered by endpoint name or site.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                name: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by DDM endpoint name (e.g. 'AGLT2_DATADISK')."),
                site: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by the ATLAS site the endpoint belongs to (e.g. 'AGLT2')."),
            }
        },
        async ({ name, site }) => withToolLog("list_ddm_endpoints", { name, site }, async () => {
            const proxyPath = process.env.X509_USER_PROXY;
            const certDir = process.env.X509_CERT_DIR;

            if (!proxyPath || !certDir) {
                return {
                    content: [{
                        type: "text" as const,
                        text: "Error: X509_USER_PROXY or X509_CERT_DIR environment variables not set",
                    }],
                    isError: true,
                };
            }

            let proxyPem: Buffer;
            let caCerts: Buffer[];
            try {
                proxyPem = fs.readFileSync(proxyPath);
                caCerts = fs.readdirSync(certDir)
                    .filter(f => f.endsWith('.pem') || f.endsWith('.crt'))
                    .map(f => fs.readFileSync(path.join(certDir, f)));
            } catch (err) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error reading certificate files: ${err}`,
                    }],
                    isError: true,
                };
            }

            const agent = new https.Agent({
                cert: proxyPem,
                key: proxyPem,
                ca: caCerts,
                rejectUnauthorized: true,
            });

            const params = new URLSearchParams({ json: '' });
            if (name) params.set('name', name);
            if (site) params.set('site', site);
            const url = `https://atlas-cric.cern.ch/api/atlas/ddmendpoint/query/?${params}`;

            const started = process.hrtime.bigint();
            const data = await new Promise<string>((resolve, reject) => {
                https.get(
                    url,
                    { agent },
                    (res) => {
                        let body = '';
                        res.on('data', (chunk: string) => body += chunk);
                        res.on('end', () => {
                            logUpstream('cric', 'GET', new URL(url).pathname, res.statusCode ?? 0, started);
                            resolve(body);
                        });
                    }
                ).on('error', reject);
            });

            return {
                content: [{
                    type: "text" as const,
                    text: data,
                }],
            };
        })
    );

    server.registerTool(
        "list_panda_queues",
        {
            title: "List PanDA Queues",
            description: "List ATLAS PanDA queues from CRIC, optionally filtered by name, state, or status.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                name: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by queue name (e.g. 'AGLT2_TEST')."),
                state: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by queue state (e.g. 'ACTIVE')."),
                status: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by queue status (e.g. 'online', 'offline')."),
            }
        },
        async ({ name, state, status }) => withToolLog("list_panda_queues", { name, state, status }, async () => {
            const proxyPath = process.env.X509_USER_PROXY;
            const certDir = process.env.X509_CERT_DIR;

            if (!proxyPath || !certDir) {
                return {
                    content: [{
                        type: "text" as const,
                        text: "Error: X509_USER_PROXY or X509_CERT_DIR environment variables not set",
                    }],
                    isError: true,
                };
            }

            let proxyPem: Buffer;
            let caCerts: Buffer[];
            try {
                proxyPem = fs.readFileSync(proxyPath);
                caCerts = fs.readdirSync(certDir)
                    .filter(f => f.endsWith('.pem') || f.endsWith('.crt'))
                    .map(f => fs.readFileSync(path.join(certDir, f)));
            } catch (err) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error reading certificate files: ${err}`,
                    }],
                    isError: true,
                };
            }

            const agent = new https.Agent({
                cert: proxyPem,
                key: proxyPem,
                ca: caCerts,
                rejectUnauthorized: true,
            });

            const params = new URLSearchParams({ json: '' });
            if (name) params.set('name', name);
            if (state) params.set('state', state);
            if (status) params.set('status', status);
            const url = `https://atlas-cric.cern.ch/api/atlas/pandaqueue/query/?${params}`;

            const started = process.hrtime.bigint();
            const data = await new Promise<string>((resolve, reject) => {
                https.get(
                    url,
                    { agent },
                    (res) => {
                        let body = '';
                        res.on('data', (chunk: string) => body += chunk);
                        res.on('end', () => {
                            logUpstream('cric', 'GET', new URL(url).pathname, res.statusCode ?? 0, started);
                            resolve(body);
                        });
                    }
                ).on('error', reject);
            });

            return {
                content: [{
                    type: "text" as const,
                    text: data,
                }],
            };
        })
    );

    server.registerTool(
        "list_panda_queue_tags",
        {
            title: "List PanDA Queue Tags",
            description: "List ATLAS PanDA queue tags from CRIC, optionally filtered by queue name.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                panda_queue: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by PanDA queue name (e.g. 'AGLT2_TEST')."),
            }
        },
        async ({ panda_queue }) => withToolLog("list_panda_queue_tags", { panda_queue }, async () => {
            const proxyPath = process.env.X509_USER_PROXY;
            const certDir = process.env.X509_CERT_DIR;

            if (!proxyPath || !certDir) {
                return {
                    content: [{
                        type: "text" as const,
                        text: "Error: X509_USER_PROXY or X509_CERT_DIR environment variables not set",
                    }],
                    isError: true,
                };
            }

            let proxyPem: Buffer;
            let caCerts: Buffer[];
            try {
                proxyPem = fs.readFileSync(proxyPath);
                caCerts = fs.readdirSync(certDir)
                    .filter(f => f.endsWith('.pem') || f.endsWith('.crt'))
                    .map(f => fs.readFileSync(path.join(certDir, f)));
            } catch (err) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error reading certificate files: ${err}`,
                    }],
                    isError: true,
                };
            }

            const agent = new https.Agent({
                cert: proxyPem,
                key: proxyPem,
                ca: caCerts,
                rejectUnauthorized: true,
            });

            const params = new URLSearchParams({ json: '', preset: 'tags' });
            if (panda_queue) params.set('panda_queue', panda_queue);
            const url = `https://atlas-cric.cern.ch/api/atlas/pandaqueue/query/?${params}`;

            const started = process.hrtime.bigint();
            const data = await new Promise<string>((resolve, reject) => {
                https.get(
                    url,
                    { agent },
                    (res) => {
                        let body = '';
                        res.on('data', (chunk: string) => body += chunk);
                        res.on('end', () => {
                            logUpstream('cric', 'GET', new URL(url).pathname, res.statusCode ?? 0, started);
                            resolve(body);
                        });
                    }
                ).on('error', reject);
            });

            return {
                content: [{
                    type: "text" as const,
                    text: data,
                }],
            };
        })
    );

    server.registerTool(
        "fetch_x509_url",
        {
            title: "Fetch URL with x509 Proxy",
            description: "HTTP GET a URL using the service's ATLAS grid x509 proxy as the client certificate, and return the response body. "
                + "Use it for URLs found in CRIC data that need grid authentication, e.g. a DDM endpoint's info_url / space_usage_url "
                + "(storage space usage report, SRR JSON) or an FTS server from servedrestfts (e.g. 'https://fts3-atlas.cern.ch:8446/config/...'). "
                + "Accepts https://, davs:// (fetched as https) and http:// (no certificate sent). Private and cluster-internal addresses are refused.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                url: z
                    .string()
                    .trim()
                    .min(1)
                    .describe("Full URL to GET, e.g. 'https://fts3-atlas.cern.ch:8446/whoami' or an endpoint's info_url."),
                max_bytes: z
                    .number()
                    .int()
                    .min(1024)
                    .max(5_000_000)
                    .optional()
                    .describe("Maximum response size to return, in bytes (default 1000000). Larger bodies are truncated."),
            }
        },
        async ({ url, max_bytes }) => withToolLog("fetch_x509_url", { url, max_bytes }, async () => {
            let result: FetchResult;
            try {
                result = await fetchWithX509(url, max_bytes ?? 1_000_000, 30_000);
            } catch (err) {
                return {
                    content: [{ type: "text" as const, text: `Error fetching ${url}: ${err instanceof Error ? err.message : err}` }],
                    isError: true,
                };
            }
            const header = [
                `URL: ${result.url}`,
                `HTTP ${result.status}${result.contentType ? `, ${result.contentType}` : ''}`,
                ...(result.truncated ? [`(truncated to ${max_bytes ?? 1_000_000} bytes)`] : []),
            ].join("\n");
            return {
                content: [{ type: "text" as const, text: `${header}\n\n${result.body}` }],
                isError: result.status < 200 || result.status >= 300,
            };
        })
    );

    return server;
}


const app = express();
app.use(cors({
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['WWW-Authenticate'],
}));
app.use(express.json());
app.use(requestLogger);

app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata);

app.post('/mcp', requireApiKey, async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    });
    const server = await createCricMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
});


const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    log.info(`CRIC MCP Streamable HTTP Server listening on port ${PORT}`);
});

process.on('SIGINT', async () => {
    log.info('Shutting down server...');
    process.exit(0);
});

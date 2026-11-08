/**
 * Originals, content-addressed: the object key is the sha256 of the bytes, so storing the
 * same document twice is a no-op and a blob can never silently change under a citation.
 *
 * S3 in the cluster (NRP Ceph), a plain directory for local development. With neither
 * configured, documents are ingested without an original (blob_ref stays null) — the
 * claims and their quoted spans are still stored, but replay cannot re-read the source.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { blobBackend, config } from '../config.js';
import { log, logUpstream } from '../logger.js';

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

let s3: S3Client | null = null;
function client(): S3Client {
    s3 ??= new S3Client({
        endpoint: config.blob.s3Endpoint,
        region: process.env.S3_REGION ?? 'us-east-1',
        forcePathStyle: true,
        credentials: { accessKeyId: config.blob.s3AccessKey!, secretAccessKey: config.blob.s3SecretKey! },
    });
    return s3;
}

const key = (hash: string) => `sha256/${hash.slice(0, 2)}/${hash}`;

/** Shape of the fields the AWS SDK hangs on a failed command. */
type SdkError = {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
    $response?: { statusCode?: number; headers?: Record<string, string>; body?: unknown };
    $responseBodyText?: string;
};

const BODY_SNIPPET = 300;

/** HTTP status of a failed SDK call, or 0 when no response came back (network error). */
function sdkStatus(err: unknown): number {
    const e = (err ?? {}) as SdkError;
    return e.$metadata?.httpStatusCode ?? e.$response?.statusCode ?? 0;
}

const isNotFound = (err: unknown) => (err as SdkError)?.name === 'NotFound' || sdkStatus(err) === 404;

/** Read at most `max` bytes of a Node or web stream, giving up after a second. Never throws. */
async function readStreamHead(body: unknown, max: number): Promise<Buffer | null> {
    const node = body as NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean };
    const web = body as ReadableStream<Uint8Array>;
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000).unref());
    try {
        if (typeof web?.getReader === 'function') {
            if (web.locked) return null;
            const reader = web.getReader();
            const chunk = await Promise.race([reader.read(), timeout]);
            reader.cancel().catch(() => {});
            return chunk && chunk.value ? Buffer.from(chunk.value).subarray(0, max) : null;
        }
        if (typeof node?.on === 'function' && !node.readableEnded && !node.destroyed) {
            const chunks: Buffer[] = [];
            let size = 0;
            const done = new Promise<Buffer>((resolve) => {
                const finish = () => resolve(Buffer.concat(chunks).subarray(0, max));
                node.on('data', (c: Buffer | string) => {
                    const b = Buffer.from(c);
                    chunks.push(b);
                    size += b.length;
                    if (size >= max) finish();
                });
                node.on('end', finish);
                node.on('error', finish);
            });
            return await Promise.race([done, timeout]);
        }
    } catch { /* fall through */ }
    return null;
}

/** First bytes of the error response body, newlines collapsed; '' when there is none. Never throws. */
async function bodySnippet(err: SdkError): Promise<string> {
    try {
        const body = err.$responseBodyText ?? err.$response?.body;
        if (body === undefined || body === null) return '';
        let bytes: Buffer | null;
        if (typeof body === 'string') bytes = Buffer.from(body);
        else if (body instanceof Uint8Array) bytes = Buffer.from(body);
        else bytes = await readStreamHead(body, BODY_SNIPPET);
        if (!bytes) return '<unreadable>';
        return bytes.subarray(0, BODY_SNIPPET).toString('utf8').replace(/\s+/g, ' ').trim();
    } catch {
        return '<unreadable>';
    }
}

/**
 * One-line summary of a failed S3 call: status, error name, response content-type and
 * server, and the start of the response body. A non-XML body (a proxy's maintenance page,
 * say) makes the SDK report a useless "XML parse error"; the real cause is in $response.
 * Only response data is included — never request headers, credentials or object contents.
 */
async function describeS3Error(method: string, err: unknown): Promise<string> {
    const e = (err ?? {}) as SdkError;
    const status = sdkStatus(err);
    const name = e.Code ?? e.name;
    const headers = e.$response?.headers ?? {};
    const header = (h: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === h)?.[1];
    const parts = [status ? String(status) : 'no response'];
    // Generic names add nothing: a deserialization failure is plain 'Error', a bodiless one 'Unknown'.
    if (name && !['Error', 'Unknown', String(status)].includes(name)) parts.push(name);
    const contentType = header('content-type');
    if (contentType) parts.push(contentType.split(';')[0]);
    const server = header('server');
    if (server) parts.push(`server=${server}`);
    // A HEAD response never has a body.
    const body = method === 'HEAD' || header('content-length') === '0' ? '' : await bodySnippet(e);
    const message = !status && !body ? `: ${(err as Error)?.message ?? err}` : '';
    return `${parts.join(' ')}${body ? `: "${body}"` : message}`;
}

/** Log a failed S3 call at its real status and rethrow it with the cause spelled out. */
async function s3Failure(method: string, objectKey: string, err: unknown, started: bigint): Promise<never> {
    const status = sdkStatus(err);
    const summary = await describeS3Error(method, err);
    if (status) logUpstream('s3', method, objectKey, status, started);
    // No HTTP response at all (DNS, refused, timeout): logUpstream would file a 0 as INFO.
    else log.warn(`s3 ${method} ${objectKey} ${summary}`);
    throw new Error(`S3 ${method} ${objectKey} failed: ${summary}`, { cause: err });
}

/** Store bytes; returns the blob ref, or null when no blob store is configured. */
export async function putBlob(data: Buffer, contentType: string): Promise<string | null> {
    const hash = sha256(data);
    const backend = blobBackend();
    if (backend === 'none') {
        log.warn(`blob store not configured — ${hash.slice(0, 12)} stored without its original`);
        return null;
    }
    if (backend === 'dir') {
        const file = path.join(config.blob.dir!, key(hash));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, data, { flag: 'w' });
        return `file:${key(hash)}`;
    }
    const objectKey = key(hash);
    let started = process.hrtime.bigint();
    try {
        const head = await client().send(new HeadObjectCommand({ Bucket: config.blob.s3Bucket, Key: objectKey }));
        logUpstream('s3', 'HEAD', objectKey, head.$metadata.httpStatusCode ?? 200, started);
        return `s3:${config.blob.s3Bucket}/${objectKey}`;
    } catch (err) {
        // Only a missing object means "upload it"; anything else (auth, network, 5xx) is a failure.
        if (!isNotFound(err)) await s3Failure('HEAD', objectKey, err, started);
        // Same line format as logUpstream, but at INFO: a miss is the normal path for a new blob.
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        log.info(`s3 HEAD ${objectKey} 404 ${ms.toFixed(1)}ms`);
    }
    started = process.hrtime.bigint();
    try {
        const put = await client().send(new PutObjectCommand({
            Bucket: config.blob.s3Bucket, Key: objectKey, Body: data, ContentType: contentType,
        }));
        logUpstream('s3', 'PUT', objectKey, put.$metadata.httpStatusCode ?? 200, started);
    } catch (err) {
        await s3Failure('PUT', objectKey, err, started);
    }
    return `s3:${config.blob.s3Bucket}/${objectKey}`;
}

export async function getBlob(ref: string): Promise<Buffer> {
    if (ref.startsWith('file:')) {
        if (!config.blob.dir) throw new Error('BLOB_DIR is not set');
        return readFile(path.join(config.blob.dir, ref.slice(5)));
    }
    if (ref.startsWith('s3:')) {
        const [bucket, ...rest] = ref.slice(3).split('/');
        const objectKey = rest.join('/');
        const started = process.hrtime.bigint();
        let out;
        try {
            out = await client().send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
        } catch (err) {
            return s3Failure('GET', objectKey, err, started);
        }
        logUpstream('s3', 'GET', objectKey, out.$metadata.httpStatusCode ?? 200, started);
        return Buffer.from(await out.Body!.transformToByteArray());
    }
    throw new Error(`unknown blob ref '${ref}'`);
}

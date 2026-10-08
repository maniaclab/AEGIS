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
    const started = process.hrtime.bigint();
    try {
        await client().send(new HeadObjectCommand({ Bucket: config.blob.s3Bucket, Key: key(hash) }));
        logUpstream('s3', 'HEAD', key(hash), 200, started);
    } catch {
        await client().send(new PutObjectCommand({
            Bucket: config.blob.s3Bucket, Key: key(hash), Body: data, ContentType: contentType,
        }));
        logUpstream('s3', 'PUT', key(hash), 200, started);
    }
    return `s3:${config.blob.s3Bucket}/${key(hash)}`;
}

export async function getBlob(ref: string): Promise<Buffer> {
    if (ref.startsWith('file:')) {
        if (!config.blob.dir) throw new Error('BLOB_DIR is not set');
        return readFile(path.join(config.blob.dir, ref.slice(5)));
    }
    if (ref.startsWith('s3:')) {
        const [bucket, ...rest] = ref.slice(3).split('/');
        const started = process.hrtime.bigint();
        const out = await client().send(new GetObjectCommand({ Bucket: bucket, Key: rest.join('/') }));
        logUpstream('s3', 'GET', rest.join('/'), 200, started);
        return Buffer.from(await out.Body!.transformToByteArray());
    }
    throw new Error(`unknown blob ref '${ref}'`);
}

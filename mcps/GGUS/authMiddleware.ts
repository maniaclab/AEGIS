
import { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { log } from './logger.js';

dotenv.config();

const VALID_API_KEYS = new Set([
    process.env.API_KEY_1!,
    process.env.API_KEY_2!,
]);

const keycloakClient = process.env.KEYCLOAK_URL && process.env.KEYCLOAK_REALM
    ? jwksClient({
        jwksUri: `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/certs`,
        cache: true,
        cacheMaxAge: 600_000,
      })
    : null;

function getSigningKey(kid: string): Promise<string> {
    return new Promise((resolve, reject) => {
        keycloakClient!.getSigningKey(kid, (err, key) => {
            if (err) return reject(err);
            resolve(key!.getPublicKey());
        });
    });
}

async function validateKeycloakToken(token: string): Promise<boolean> {
    if (!keycloakClient) return false;
    try {
        const decoded = jwt.decode(token, { complete: true });
        if (!decoded || typeof decoded === 'string' || !decoded.header.kid) return false;
        const signingKey = await getSigningKey(decoded.header.kid);
        jwt.verify(token, signingKey, {
            algorithms: ['RS256'],
            ...(process.env.KEYCLOAK_AUDIENCE && { audience: process.env.KEYCLOAK_AUDIENCE }),
        });
        return true;
    } catch {
        return false;
    }
}

export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeaderRaw = req.headers['authorization'] || req.headers['Authorization'];
    const authHeader = Array.isArray(authHeaderRaw) ? authHeaderRaw[0] : authHeaderRaw;
    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer')) {
        log.warn(`auth rejected: missing or invalid Authorization header ip=${req.ip ?? '-'}`);
        res.status(401).json({ error: 'Missing or invalid Authorization header' });
        return;
    }

    const token = authHeader.slice('Bearer '.length).trim();

    if (VALID_API_KEYS.has(token)) {
        log.debug(`auth ok: api key ip=${req.ip ?? '-'}`);
        return next();
    }

    if (await validateKeycloakToken(token)) {
        log.debug(`auth ok: keycloak token ip=${req.ip ?? '-'}`);
        return next();
    }

    log.warn(`auth rejected: invalid API key or token ip=${req.ip ?? '-'}`);
    res.status(403).json({ error: 'Invalid API key or token' });
}

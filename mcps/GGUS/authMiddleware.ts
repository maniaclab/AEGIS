
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

const issuer = process.env.KEYCLOAK_URL && process.env.KEYCLOAK_REALM
    ? `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM}`
    : null;

const keycloakClient = issuer
    ? jwksClient({
        jwksUri: `${issuer}/protocol/openid-connect/certs`,
        cache: true,
        cacheMaxAge: 600_000,
      })
    : null;

const resourceUrl = process.env.MCP_RESOURCE_URL;

// Keycloak client scope whose audience mapper adds KEYCLOAK_AUDIENCE to the token.
const oauthScope = process.env.MCP_OAUTH_SCOPE ?? 'ggus-mcp';

// Clients that send no token are pointed here to discover Keycloak and run the OAuth flow.
const oauthEnabled = !!(issuer && resourceUrl);
const resourceMetadataUrl = oauthEnabled
    ? `${new URL(resourceUrl!).origin}/.well-known/oauth-protected-resource${new URL(resourceUrl!).pathname}`
    : null;

export function protectedResourceMetadata(_req: Request, res: Response): void {
    if (!oauthEnabled) {
        res.status(404).json({ error: 'OAuth is not configured' });
        return;
    }
    res.json({
        resource: resourceUrl,
        authorization_servers: [issuer],
        scopes_supported: [oauthScope],
        bearer_methods_supported: ['header'],
        resource_name: 'GGUS MCP',
    });
}

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
            issuer: issuer!,
            ...(process.env.KEYCLOAK_AUDIENCE && { audience: process.env.KEYCLOAK_AUDIENCE }),
        });
        return true;
    } catch {
        return false;
    }
}

// RFC 6750 / MCP spec: missing and invalid tokens both get 401 so clients (re)start the OAuth flow.
function unauthorized(res: Response, error?: 'invalid_token'): void {
    if (resourceMetadataUrl) {
        const params = [
            ...(error ? [`error="${error}"`] : []),
            `resource_metadata="${resourceMetadataUrl}"`,
            `scope="${oauthScope}"`,
        ];
        res.set('WWW-Authenticate', `Bearer ${params.join(', ')}`);
    } else {
        res.set('WWW-Authenticate', 'Bearer');
    }
    res.status(401).json({ error: error ? 'Invalid API key or token' : 'Missing or invalid Authorization header' });
}

export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.get('authorization');
    const match = authHeader?.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        log.warn(`auth rejected: missing or invalid Authorization header ip=${req.ip ?? '-'}`);
        unauthorized(res);
        return;
    }

    const token = match[1].trim();

    if (VALID_API_KEYS.has(token)) {
        log.debug(`auth ok: api key ip=${req.ip ?? '-'}`);
        return next();
    }

    if (await validateKeycloakToken(token)) {
        log.debug(`auth ok: keycloak token ip=${req.ip ?? '-'}`);
        return next();
    }

    log.warn(`auth rejected: invalid API key or token ip=${req.ip ?? '-'}`);
    unauthorized(res, 'invalid_token');
}

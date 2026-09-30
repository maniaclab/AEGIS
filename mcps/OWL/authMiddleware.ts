import { Request, Response, NextFunction } from 'express';
import { log } from './logger.js';
import { config } from './config.js';
import { identifyKeycloakToken, identifyServiceKey, keycloakIssuer } from './identity.js';

const { resourceUrl, scope } = config.keycloak;

// Clients that send no token are pointed here to discover Keycloak and run the OAuth flow.
const resourceMetadataUrl = keycloakIssuer && resourceUrl
    ? `${new URL(resourceUrl).origin}/.well-known/oauth-protected-resource${new URL(resourceUrl).pathname}`
    : null;

export function protectedResourceMetadata(_req: Request, res: Response): void {
    if (!resourceMetadataUrl) {
        res.status(404).json({ error: 'OAuth is not configured' });
        return;
    }
    res.json({
        resource: resourceUrl,
        authorization_servers: [keycloakIssuer],
        ...(scope && { scopes_supported: [scope] }),
        bearer_methods_supported: ['header'],
    });
}

// RFC 6750 / MCP spec: missing and invalid tokens both get 401 so clients (re)start the OAuth flow.
function unauthorized(res: Response, error?: 'invalid_token'): void {
    if (resourceMetadataUrl) {
        const params = [
            ...(error ? [`error="${error}"`] : []),
            `resource_metadata="${resourceMetadataUrl}"`,
            ...(scope ? [`scope="${scope}"`] : []),
        ];
        res.set('WWW-Authenticate', `Bearer ${params.join(', ')}`);
    } else {
        res.set('WWW-Authenticate', 'Bearer');
    }
    res.status(401).json({ error: error ? 'Invalid API key or token' : 'Missing or invalid Authorization header' });
}

/**
 * Authenticate the bearer token and attach the resolved identity to the request.
 *
 * Both shared service keys and Keycloak tokens are accepted, but they are not equivalent:
 * a service key can read, only a person can write. Tools enforce that via
 * `req.owlIdentity.canWrite`; this middleware only establishes who is asking.
 */
export async function requireIdentity(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.get('authorization');
    const match = authHeader?.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        log.warn(`auth rejected: missing or invalid Authorization header ip=${req.ip ?? '-'}`);
        unauthorized(res);
        return;
    }

    const token = match[1].trim();

    const service = identifyServiceKey(token);
    if (service) {
        log.debug(`auth ok: ${service.id} (read-only) ip=${req.ip ?? '-'}`);
        req.owlIdentity = service;
        return next();
    }

    const identity = await identifyKeycloakToken(token);
    if (identity) {
        log.debug(
            `auth ok: ${identity.id} user=${identity.username ?? '-'} ` +
            `write=${identity.canWrite} trusted=${identity.trusted} ip=${req.ip ?? '-'}`,
        );
        req.owlIdentity = identity;
        return next();
    }

    log.warn(`auth rejected: invalid API key or token ip=${req.ip ?? '-'}`);
    unauthorized(res, 'invalid_token');
}

import { Request, Response, NextFunction } from 'express';
import { log } from './logger.js';
import { identifyKeycloakToken, identifyServiceKey } from './identity.js';

/**
 * Authenticate the bearer token and attach the resolved identity to the request.
 *
 * Both shared service keys and Keycloak tokens are accepted, but they are not equivalent:
 * a service key can read, only a person can write. Tools enforce that via
 * `req.owlIdentity.canWrite`; this middleware only establishes who is asking.
 */
export async function requireIdentity(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeaderRaw = req.headers['authorization'] || req.headers['Authorization'];
    const authHeader = Array.isArray(authHeaderRaw) ? authHeaderRaw[0] : authHeaderRaw;
    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer')) {
        log.warn(`auth rejected: missing or invalid Authorization header ip=${req.ip ?? '-'}`);
        res.status(401).json({ error: 'Missing or invalid Authorization header' });
        return;
    }

    const token = authHeader.slice('Bearer '.length).trim();

    const service = identifyServiceKey(token);
    if (service) {
        log.debug(`auth ok: ${service.id} (read-only) ip=${req.ip ?? '-'}`);
        req.owlIdentity = service;
        return next();
    }

    const person = await identifyKeycloakToken(token);
    if (person) {
        log.debug(
            `auth ok: ${person.id} user=${person.username ?? '-'} ` +
            `trusted=${person.trusted} ip=${req.ip ?? '-'}`,
        );
        req.owlIdentity = person;
        return next();
    }

    log.warn(`auth rejected: invalid API key or token ip=${req.ip ?? '-'}`);
    res.status(403).json({ error: 'Invalid API key or token' });
}

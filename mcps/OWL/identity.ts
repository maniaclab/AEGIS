/**
 * Who is calling.
 *
 * OWL differs from the other AF MCPs here: they only need to know whether a request is
 * authorized, so their middleware returns a boolean. OWL *writes* attributed knowledge, so
 * a request must resolve to a durable identity — provenance, ownership, dispute routing and
 * rate limits all key off it. Anonymous writes are worse than no writes.
 */
import jwt, { JwtPayload } from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { config } from './config.js';

export interface Identity {
    /** A real person (Keycloak user token) or a service (shared key or Keycloak service account). */
    kind: 'person' | 'service';
    /** Stable id used in provenance and audit rows: `kc:<sub>`, `svc:<n>` or `svc:kc:<client>`. */
    id: string;
    username?: string;
    email?: string;
    groups: string[];
    /** Service keys may read only. Writing requires a person. */
    canWrite: boolean;
    /** May submit for extraction. People always; services only when on OWL_SUBMIT_SERVICES. */
    canSubmit: boolean;
    /** Trusted writers commit directly; everyone else quarantines. */
    trusted: boolean;
    /** Keycloak `jti`, recorded in the audit log. */
    tokenId?: string;
}

/** A service identity, read-only unless it is on the submit list. Never trusted. */
function service(id: string, username?: string): Identity {
    return {
        kind: 'service',
        id,
        username,
        groups: [],
        canWrite: false,
        canSubmit: config.submitServices.includes(id),
        trusted: false,
    };
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            owlIdentity?: Identity;
        }
    }
}

export const keycloakIssuer = config.keycloak.url && config.keycloak.realm
    ? `${config.keycloak.url}/realms/${config.keycloak.realm}`
    : null;

const keycloak = keycloakIssuer
    ? jwksClient({
        jwksUri: `${keycloakIssuer}/protocol/openid-connect/certs`,
        cache: true,
        cacheMaxAge: 600_000,
    })
    : null;

function getSigningKey(kid: string): Promise<string> {
    return new Promise((resolve, reject) => {
        keycloak!.getSigningKey(kid, (err, key) => {
            if (err) return reject(err);
            resolve(key!.getPublicKey());
        });
    });
}

/** Resolve a shared service key to a read-only service identity, or null. */
export function identifyServiceKey(token: string): Identity | null {
    const index = config.serviceKeys.indexOf(token);
    if (index === -1) return null;
    return service(`svc:${index + 1}`);
}

/**
 * Verify a Keycloak access token and turn its claims into an identity, or null.
 *
 * Client-credentials tokens are signed by the same realm but stand for a machine, not a
 * person, so they get the same read-only service identity as a shared key.
 */
export async function identifyKeycloakToken(token: string): Promise<Identity | null> {
    if (!keycloak) return null;
    try {
        const decoded = jwt.decode(token, { complete: true });
        if (!decoded || typeof decoded === 'string' || !decoded.header.kid) return null;
        const signingKey = await getSigningKey(decoded.header.kid);
        const payload = jwt.verify(token, signingKey, {
            algorithms: ['RS256'],
            issuer: keycloakIssuer!,
            ...(config.keycloak.audience && { audience: config.keycloak.audience }),
        }) as JwtPayload;

        const sub = payload.sub;
        if (!sub) return null;

        const username = typeof payload.preferred_username === 'string'
            ? payload.preferred_username
            : undefined;

        // Keycloak names service-account users `service-account-<client>` and its
        // service_account scope adds `client_id` (`clientId` before Keycloak 25); any of
        // these marks a client-credentials token.
        if (
            username?.startsWith('service-account-')
            || typeof payload.client_id === 'string'
            || typeof payload.clientId === 'string'
        ) {
            return service(`svc:kc:${typeof payload.azp === 'string' ? payload.azp : sub}`, username);
        }

        const email = typeof payload.email === 'string' ? payload.email : undefined;
        const groups = Array.isArray(payload.groups)
            ? payload.groups.filter((g): g is string => typeof g === 'string')
            : [];

        return {
            kind: 'person',
            id: `kc:${sub}`,
            username,
            email,
            groups,
            canWrite: true,
            canSubmit: true,
            trusted: isTrusted(sub, username, email),
            tokenId: typeof payload.jti === 'string' ? payload.jti : undefined,
        };
    } catch {
        return null;
    }
}

/**
 * A writer is trusted if any of its identifiers is on the configured list — subject,
 * username or email — so the list can be maintained in whichever form is at hand.
 */
function isTrusted(sub: string, username?: string, email?: string): boolean {
    const mine = [sub, username, email].filter((v): v is string => !!v).map((v) => v.toLowerCase());
    return config.trustedWriters.some((w) => mine.includes(w.toLowerCase()));
}

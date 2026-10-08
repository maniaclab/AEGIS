/**
 * Entity resolution: the subject a model names -> an entity id.
 *
 * In order: an exact id/name/alias match; a close trigram match on aliases; CRIC, for
 * things that look like sites (CRIC is the backbone where it has the entity, and gives a
 * join path into live state); otherwise a new *provisional* entity, flagged for review.
 * Resolution itself never writes — commit.ts creates entities when claims are committed.
 */
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { log, logUpstream } from '../logger.js';

export interface Resolution {
    id: string;
    name: string;
    kind: string;
    /** known: already in OWL; cric: new, anchored to CRIC; new: new and provisional. */
    via: 'known' | 'fuzzy' | 'cric' | 'new';
    cric_ref?: string;
}

const FUZZY = 0.6;

export const slug = (name: string) =>
    name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'unnamed';

/** ATLAS site names: upper case, digits, dashes and underscores, e.g. CSCS-LCG2, BNL-ATLAS. */
const SITE_LIKE = /^[A-Z][A-Z0-9]*([_-][A-Z0-9]+)+$/;

/**
 * Whether a model's subject can name a system at all. Small models put values and fields
 * in the subject ("8.0", "it", a whole command line); such a claim gets no subject rather
 * than a junk entity. It stays findable through search, and review can assign one.
 */
export function plausibleSubject(mention: string): boolean {
    const m = mention.trim();
    if (m.length < 2 || m.length > 48) return false;
    if (/^[\d.\s:/-]+$/.test(m)) return false;          // a number, version, port or date
    if (/^[a-z]{1,3}$/.test(m)) return false;             // "it", "es", "kind"-like fragments
    if (m.split(/\s+/).length > 5) return false;          // a sentence, not a name
    return true;
}

export async function resolveMention(mention: string, kind: string): Promise<Resolution | null> {
    if (!plausibleSubject(mention)) return null;
    const exact = await pool.query<{ id: string; name: string; kind: string }>(`
        SELECT e.id, e.name, e.kind FROM entities e
        WHERE e.id = $1 OR lower(e.name) = lower($1)
           OR e.id IN (SELECT entity_id FROM entity_aliases WHERE lower(alias) = lower($1))
        ORDER BY e.provisional, e.id LIMIT 1`, [mention]);
    if (exact.rows[0]) return { ...exact.rows[0], via: 'known' };

    const fuzzy = await pool.query<{ id: string; name: string; kind: string; s: number }>(`
        SELECT e.id, e.name, e.kind, max(similarity(lower(a.alias), lower($1))) AS s
        FROM entity_aliases a JOIN entities e ON e.id = a.entity_id
        GROUP BY e.id HAVING max(similarity(lower(a.alias), lower($1))) >= $2
        ORDER BY s DESC LIMIT 1`, [mention, FUZZY]);
    if (fuzzy.rows[0]) {
        const { s: _s, ...e } = fuzzy.rows[0];
        return { ...e, via: 'fuzzy' };
    }

    if (kind === 'site' || SITE_LIKE.test(mention)) {
        const site = await cricSite(mention);
        if (site) return { id: slug(site), name: site, kind: 'site', via: 'cric', cric_ref: site };
    }
    return { id: slug(mention), name: mention, kind, via: 'new' };
}

const cricCache = new Map<string, string | null>();

/** The CRIC rc site name, if CRIC knows the site; null otherwise or when CRIC is unreachable. */
async function cricSite(name: string): Promise<string | null> {
    if (!config.cricMcpUrl || !config.serviceKeys[0]) return null;
    const cached = cricCache.get(name.toUpperCase());
    if (cached !== undefined) return cached;
    const started = process.hrtime.bigint();
    try {
        const res = await fetch(config.cricMcpUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                Authorization: `Bearer ${config.serviceKeys[0]}`,
            },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 1, method: 'tools/call',
                params: { name: 'list_rc_sites', arguments: { name } },
            }),
            signal: AbortSignal.timeout(20_000),
        });
        logUpstream('cric', 'POST', 'list_rc_sites', res.status, started);
        const body = await res.json() as { result?: { content?: { text: string }[] } };
        const sites = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
        const hit = Object.keys(sites).find((k) => k !== 'error' && k.toUpperCase() === name.toUpperCase()) ?? null;
        cricCache.set(name.toUpperCase(), hit);
        return hit;
    } catch (err) {
        log.warn(`cric lookup for '${name}' failed: ${err}`);
        return null;
    }
}

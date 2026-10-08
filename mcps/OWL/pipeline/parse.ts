/**
 * Parsers: raw input -> the text that extraction reads and spans point into.
 *
 * Offsets are what make provenance verifiable, so a parser never "cleans up" text it does
 * not also map back. Text and markdown pass through untouched — the parsed text *is* the
 * original. A conversation is rendered to a labelled transcript, and the parser records
 * which ranges are human turns: those are the only assertable spans (the conversation
 * rule — assistant turns are context, never sources).
 *
 * PDF, PPTX and HTML parsers are still to come; their offsets will point into the parsed
 * text, which is stored next to the original (documents.text_ref).
 */

export interface ParsedDocument {
    text: string;
    parserVersion: string;
    mediaType: string;
    /** UTF-16 ranges a claim may be quoted from; null means the whole text. */
    assertable: [number, number][] | null;
}

export interface Turn {
    role: string;
    content: string;
}

export const TEXT_MEDIA_TYPES = ['text/plain', 'text/markdown'];
const HUMAN_ROLES = new Set(['user', 'human']);

export function parseText(raw: string, mediaType: string): ParsedDocument {
    if (!TEXT_MEDIA_TYPES.includes(mediaType)) {
        throw new Error(`no parser for ${mediaType} yet (supported: ${TEXT_MEDIA_TYPES.join(', ')})`);
    }
    return { text: raw, parserVersion: 'text-v1', mediaType, assertable: null };
}

export function parseConversation(turns: Turn[]): ParsedDocument {
    let text = '';
    const assertable: [number, number][] = [];
    for (const t of turns) {
        const role = t.role.toLowerCase();
        text += `[${role}]\n`;
        const start = text.length;
        text += t.content.trim();
        if (HUMAN_ROLES.has(role)) assertable.push([start, text.length]);
        text += '\n\n';
    }
    if (!assertable.length) throw new Error('conversation has no human turns, so nothing in it can be asserted');
    return { text, parserVersion: 'conversation-v1', mediaType: 'application/x-owl-conversation', assertable };
}

/** Code point offset of a UTF-16 index, so spans agree with Postgres substring(). */
export function toCodePoints(text: string, utf16: number): number {
    return [...text.slice(0, utf16)].length;
}

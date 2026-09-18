export type ModifierType = 'none' | 'alphabet' | 'question' | 'preposition' | 'number' | 'depth2';

export interface PlannedQuery {
    query: string;
    modifierType: ModifierType;
    modifier: string | null;
}

export interface ExpansionOptions {
    expandAlphabet?: boolean;
    expandQuestions?: boolean;
    expandPrepositions?: boolean;
    expandNumbers?: boolean;
}

export const QUESTION_WORDS = [
    'who',
    'what',
    'when',
    'where',
    'why',
    'how',
    'can',
    'is',
    'are',
    'does',
    'will',
] as const;
export const PREPOSITIONS = ['for', 'with', 'without', 'near', 'to', 'vs', 'like', 'versus'] as const;
export const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');
export const NUMBERS = '0123456789'.split('');

/** Collapses whitespace and trims; used both for queries and for deduplication keys. */
export function normalizeKeyword(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim();
}

/** Case-insensitive, whitespace-insensitive key used to dedupe suggestions. */
export function dedupeKey(value: string): string {
    return normalizeKeyword(value).toLowerCase();
}

/**
 * Builds the ordered list of queries to send for one seed keyword: the seed itself first,
 * then the enabled expansions. Duplicate queries (e.g. a seed that already ends with "for")
 * are removed while keeping the first occurrence.
 */
export function buildQueries(seedKeyword: string, options: ExpansionOptions = {}): PlannedQuery[] {
    const seed = normalizeKeyword(seedKeyword);
    const planned: PlannedQuery[] = [{ query: seed, modifierType: 'none', modifier: null }];

    if (options.expandAlphabet) {
        for (const letter of ALPHABET)
            planned.push({ query: `${seed} ${letter}`, modifierType: 'alphabet', modifier: letter });
    }
    if (options.expandQuestions) {
        for (const word of QUESTION_WORDS)
            planned.push({ query: `${word} ${seed}`, modifierType: 'question', modifier: word });
    }
    if (options.expandPrepositions) {
        for (const word of PREPOSITIONS)
            planned.push({ query: `${seed} ${word}`, modifierType: 'preposition', modifier: word });
    }
    if (options.expandNumbers) {
        for (const digit of NUMBERS)
            planned.push({ query: `${seed} ${digit}`, modifierType: 'number', modifier: digit });
    }

    const seen = new Set<string>();
    return planned.filter((p) => {
        const key = dedupeKey(p.query);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Number of requests a seed keyword will produce at depth 1 with the given expansions. */
export function countQueries(options: ExpansionOptions = {}): number {
    let n = 1;
    if (options.expandAlphabet) n += ALPHABET.length;
    if (options.expandQuestions) n += QUESTION_WORDS.length;
    if (options.expandPrepositions) n += PREPOSITIONS.length;
    if (options.expandNumbers) n += NUMBERS.length;
    return n;
}

export interface ParsedSuggestion {
    suggestion: string;
    position: number;
    relevance: number | null;
    suggestType: string | null;
}

/**
 * Parses the body returned by `https://suggestqueries.google.com/complete/search?client=chrome`.
 * Shape: `[query, [suggestions...], [descriptions...], [], { "google:suggestrelevance": [...], "google:suggesttype": [...] }]`.
 * Throws when the body is not the expected JSON structure so that a 200 with junk is never billed.
 */
export function parseSuggestResponse(body: string): { echoedQuery: string; suggestions: ParsedSuggestion[] } {
    let data: unknown;
    try {
        data = JSON.parse(body.replace(/^\)\]\}'\s*/, ''));
    } catch {
        throw new Error(`Unexpected response body (not JSON): ${body.slice(0, 120)}`);
    }
    if (!Array.isArray(data) || typeof data[0] !== 'string' || !Array.isArray(data[1])) {
        throw new Error(`Unexpected response shape: ${body.slice(0, 120)}`);
    }
    const rawSuggestions = data[1] as unknown[];
    const meta = (data.find((part) => part && typeof part === 'object' && !Array.isArray(part)) ?? {}) as Record<
        string,
        unknown
    >;
    const relevance = Array.isArray(meta['google:suggestrelevance'])
        ? (meta['google:suggestrelevance'] as unknown[])
        : [];
    const types = Array.isArray(meta['google:suggesttype']) ? (meta['google:suggesttype'] as unknown[]) : [];

    const suggestions: ParsedSuggestion[] = [];
    rawSuggestions.forEach((raw, index) => {
        // client=chrome returns plain strings; some other clients wrap them in arrays.
        let text: string | null = null;
        if (typeof raw === 'string') text = raw;
        else if (Array.isArray(raw) && typeof raw[0] === 'string') text = raw[0];
        if (!text) return;
        const cleaned = normalizeKeyword(stripHtml(text));
        if (!cleaned) return;
        suggestions.push({
            suggestion: cleaned,
            position: index + 1,
            relevance: typeof relevance[index] === 'number' ? (relevance[index] as number) : null,
            suggestType: typeof types[index] === 'string' ? (types[index] as string) : null,
        });
    });

    return { echoedQuery: data[0], suggestions };
}

function stripHtml(value: string): string {
    return value.replace(/<[^>]+>/g, '');
}

export type ErrorType = 'timeout' | 'blocked' | 'rate-limited' | 'http-error' | 'network' | 'other';

export function categorizeError(message: string, statusCode?: number): ErrorType {
    const m = message.toLowerCase();
    if (statusCode === 429) return 'rate-limited';
    if (statusCode === 403 || m.includes('captcha') || m.includes('unusual traffic') || m.includes('blocked'))
        return 'blocked';
    if (statusCode && statusCode >= 400) return 'http-error';
    if (m.includes('timeout') || m.includes('timed out') || m.includes('etimedout')) return 'timeout';
    if (
        m.includes('econnrefused') ||
        m.includes('econnreset') ||
        m.includes('enotfound') ||
        m.includes('getaddrinfo') ||
        m.includes('socket') ||
        m.includes('tls') ||
        m.includes('certificate') ||
        m.includes('network')
    )
        return 'network';
    return 'other';
}

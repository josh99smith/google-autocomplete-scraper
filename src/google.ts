import { setTimeout as sleep } from 'node:timers/promises';

import { gotScraping } from 'got-scraping';

import { categorizeError, type ErrorType, type ParsedSuggestion, parseSuggestResponse } from './expand.js';

// The env override exists only so that the failure paths can be exercised against a local stub server.
export const SUGGEST_ENDPOINT =
    process.env.SUGGEST_ENDPOINT_OVERRIDE || 'https://suggestqueries.google.com/complete/search';

export interface FetchOptions {
    country: string;
    language: string;
    timeoutMs?: number;
    maxRetries?: number;
    /** Returns a proxy URL for the next attempt, or undefined to connect directly. */
    getProxyUrl?: () => Promise<string | undefined>;
    /** Random delay applied before every request to keep the request rate polite. */
    delayRangeMs?: [number, number];
}

export class SuggestError extends Error {
    constructor(
        message: string,
        public readonly errorType: ErrorType,
        public readonly statusCode?: number,
    ) {
        super(message);
        this.name = 'SuggestError';
    }
}

export interface FetchResult {
    suggestions: ParsedSuggestion[];
    attempts: number;
    fetchedAt: string;
}

export function buildSuggestUrl(query: string, country: string, language: string): string {
    const url = new URL(SUGGEST_ENDPOINT);
    // client=chrome returns up to 15 suggestions plus relevance scores and suggestion types,
    // whereas client=firefox returns at most 10 with no metadata.
    url.searchParams.set('client', 'chrome');
    url.searchParams.set('q', query);
    url.searchParams.set('hl', language);
    url.searchParams.set('gl', country);
    return url.toString();
}

function randomBetween(min: number, max: number): number {
    return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Fetches one autocomplete response with retries and exponential back-off.
 * Throws a `SuggestError` with a categorised `errorType` once all attempts are exhausted.
 */
export async function fetchSuggestions(query: string, options: FetchOptions): Promise<FetchResult> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const maxRetries = options.maxRetries ?? 2;
    const [minDelay, maxDelay] = options.delayRangeMs ?? [200, 600];
    const url = buildSuggestUrl(query, options.country, options.language);

    let lastError: SuggestError | undefined;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        await sleep(randomBetween(minDelay, maxDelay));
        try {
            const proxyUrl = options.getProxyUrl ? await options.getProxyUrl() : undefined;
            const response = await gotScraping({
                url,
                proxyUrl,
                timeout: { request: timeoutMs },
                retry: { limit: 0 },
                throwHttpErrors: false,
                responseType: 'text',
                headers: {
                    accept: 'application/json, text/javascript, */*; q=0.01',
                    'accept-language': `${options.language},en;q=0.8`,
                },
            });
            const status = response.statusCode;
            const body = typeof response.body === 'string' ? response.body : String(response.body);
            if (status !== 200) {
                const snippet = body.slice(0, 200).replace(/\s+/g, ' ');
                throw new SuggestError(
                    `HTTP ${status} from suggest endpoint: ${snippet}`,
                    categorizeError(snippet, status),
                    status,
                );
            }
            if (/unusual traffic|captcha|sorry\/index/i.test(body)) {
                throw new SuggestError('Google returned an anti-bot page instead of suggestions', 'blocked', status);
            }
            const { suggestions } = parseSuggestResponse(body);
            return { suggestions, attempts: attempt, fetchedAt: new Date().toISOString() };
        } catch (err) {
            lastError =
                err instanceof SuggestError
                    ? err
                    : new SuggestError(
                          (err as Error).message ?? String(err),
                          categorizeError((err as Error).message ?? ''),
                      );
            // An explicit anti-bot block will not fix itself on retry; rate limits and network hiccups may.
            if (lastError.errorType === 'blocked' || attempt > maxRetries) break;
            const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000) + randomBetween(0, 500);
            await sleep(backoff);
        }
    }
    throw lastError ?? new SuggestError('Unknown failure', 'other');
}

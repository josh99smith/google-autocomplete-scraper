import {
    buildQueries,
    dedupeKey,
    type ErrorType,
    type ExpansionOptions,
    type ModifierType,
    type ParsedSuggestion,
    type PlannedQuery,
} from './expand.js';

export interface SuggestionRecord {
    success: true;
    seedKeyword: string;
    query: string;
    suggestion: string;
    position: number;
    relevance: number | null;
    suggestType: string | null;
    modifierType: ModifierType;
    modifier: string | null;
    country: string;
    language: string;
    fetchedAt: string;
}

export interface FailureRecord {
    success: false;
    seedKeyword: string;
    query: string;
    errorType: ErrorType;
    error: string;
    statusCode?: number;
    fetchedAt: string;
}

export interface KeywordResult {
    seedKeyword: string;
    suggestions: SuggestionRecord[];
    failures: FailureRecord[];
    requestsMade: number;
    requestsSkipped: number;
}

export interface Fetcher {
    (query: string): Promise<{ suggestions: ParsedSuggestion[]; fetchedAt: string }>;
}

export interface CollectOptions extends ExpansionOptions {
    country: string;
    language: string;
    depth: 1 | 2;
    maxSuggestionsPerKeyword: number;
    concurrency: number;
    fetcher: Fetcher;
    /** Called after every completed request (success or failure); handy for progress logging. */
    onProgress?: (info: { query: string; found: number; total: number }) => void;
}

interface FetchError {
    errorType?: ErrorType;
    statusCode?: number;
    message?: string;
}

/**
 * Runs every planned query for one seed keyword (depth 1) and, when `depth` is 2, re-queries each
 * newly found suggestion once. Suggestions are deduplicated per seed keyword and collection stops
 * as soon as `maxSuggestionsPerKeyword` unique suggestions have been found, skipping the remaining
 * requests to keep runs cheap and polite.
 */
export async function collectKeyword(seedKeyword: string, options: CollectOptions): Promise<KeywordResult> {
    const result: KeywordResult = { seedKeyword, suggestions: [], failures: [], requestsMade: 0, requestsSkipped: 0 };
    const seen = new Set<string>([dedupeKey(seedKeyword)]);
    const queried = new Set<string>();
    const limitReached = () => result.suggestions.length >= options.maxSuggestionsPerKeyword;

    const runQuery = async (planned: PlannedQuery): Promise<void> => {
        const queryKey = dedupeKey(planned.query);
        if (queried.has(queryKey)) return;
        queried.add(queryKey);
        result.requestsMade += 1;
        try {
            const { suggestions, fetchedAt } = await options.fetcher(planned.query);
            for (const s of suggestions) {
                const key = dedupeKey(s.suggestion);
                if (seen.has(key)) continue;
                if (limitReached()) break;
                seen.add(key);
                result.suggestions.push({
                    success: true,
                    seedKeyword,
                    query: planned.query,
                    suggestion: s.suggestion,
                    position: s.position,
                    relevance: s.relevance,
                    suggestType: s.suggestType,
                    modifierType: planned.modifierType,
                    modifier: planned.modifier,
                    country: options.country,
                    language: options.language,
                    fetchedAt,
                });
            }
        } catch (err) {
            const e = err as FetchError;
            result.failures.push({
                success: false,
                seedKeyword,
                query: planned.query,
                errorType: e.errorType ?? 'other',
                error: (e.message ?? String(err)).slice(0, 500),
                statusCode: e.statusCode,
                fetchedAt: new Date().toISOString(),
            });
        }
        options.onProgress?.({
            query: planned.query,
            found: result.suggestions.length,
            total: options.maxSuggestionsPerKeyword,
        });
    };

    const runBatch = async (queue: PlannedQuery[]): Promise<void> => {
        let index = 0;
        const worker = async () => {
            while (index < queue.length) {
                if (limitReached()) {
                    result.requestsSkipped += queue.length - index;
                    index = queue.length;
                    return;
                }
                const next = queue[index++];
                await runQuery(next);
            }
        };
        const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency, queue.length)) }, worker);
        await Promise.all(workers);
    };

    // Depth 1: the seed keyword first, then the expansions.
    await runBatch(buildQueries(seedKeyword, options));

    // Depth 2: re-query every depth-1 suggestion once (only while there is still room for more results).
    if (options.depth === 2 && !limitReached()) {
        const depth2 = result.suggestions.map<PlannedQuery>((s) => ({
            query: s.suggestion,
            modifierType: 'depth2',
            modifier: s.suggestion,
        }));
        await runBatch(depth2);
    }

    return result;
}

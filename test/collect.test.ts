import { describe, expect, it } from 'vitest';

import { collectKeyword, type Fetcher } from '../src/collect.js';
import type { ParsedSuggestion } from '../src/expand.js';

const NOW = '2026-09-18T12:00:00.000Z';

function suggestion(text: string, position: number): ParsedSuggestion {
    return { suggestion: text, position, relevance: 1000 - position, suggestType: 'QUERY' };
}

/** Builds a fake fetcher from a map of query -> suggestions; records every query it receives. */
function fakeFetcher(table: Record<string, string[]>, calls: string[] = []): Fetcher & { calls: string[] } {
    const fetcher = (async (query: string) => {
        calls.push(query);
        const list = table[query] ?? [];
        return { suggestions: list.map((s, i) => suggestion(s, i + 1)), fetchedAt: NOW };
    }) as Fetcher & { calls: string[] };
    fetcher.calls = calls;
    return fetcher;
}

const base = { country: 'us', language: 'en', depth: 1 as const, maxSuggestionsPerKeyword: 50, concurrency: 3 };

describe('collectKeyword', () => {
    it('collects and shapes suggestions for a plain seed keyword', async () => {
        const fetcher = fakeFetcher({ 'best crm for': ['best crm for small business', 'best crm for real estate'] });
        const result = await collectKeyword('best crm for', { ...base, fetcher });
        expect(fetcher.calls).toEqual(['best crm for']);
        expect(result.requestsMade).toBe(1);
        expect(result.failures).toEqual([]);
        expect(result.suggestions).toHaveLength(2);
        expect(result.suggestions[0]).toEqual({
            success: true,
            seedKeyword: 'best crm for',
            query: 'best crm for',
            suggestion: 'best crm for small business',
            position: 1,
            relevance: 999,
            suggestType: 'QUERY',
            modifierType: 'none',
            modifier: null,
            country: 'us',
            language: 'en',
            fetchedAt: NOW,
        });
    });

    it('dedupes suggestions across expansions (case-insensitive) and drops the seed itself', async () => {
        const fetcher = fakeFetcher({
            crm: ['crm software', 'CRM'],
            'crm for': ['CRM Software', 'crm for small business'],
            'crm with': ['crm with email'],
        });
        const result = await collectKeyword('crm', { ...base, expandPrepositions: true, fetcher });
        const texts = result.suggestions.map((s) => s.suggestion);
        expect(texts).toEqual(['crm software', 'crm for small business', 'crm with email']);
        expect(result.suggestions[1].modifierType).toBe('preposition');
        expect(result.suggestions[1].modifier).toBe('for');
        expect(result.requestsMade).toBe(9);
    });

    it('stops sending requests once maxSuggestionsPerKeyword is reached', async () => {
        const table: Record<string, string[]> = { kw: ['kw one', 'kw two', 'kw three'] };
        for (const letter of 'abcdefghijklmnopqrstuvwxyz') table[`kw ${letter}`] = [`kw ${letter}1`, `kw ${letter}2`];
        const fetcher = fakeFetcher(table);
        const result = await collectKeyword('kw', {
            ...base,
            expandAlphabet: true,
            maxSuggestionsPerKeyword: 5,
            concurrency: 1,
            fetcher,
        });
        expect(result.suggestions).toHaveLength(5);
        expect(result.requestsMade).toBe(2); // seed (3) + "kw a" (2) = 5, the rest is skipped
        expect(result.requestsSkipped).toBe(25);
    });

    it('re-queries every depth-1 suggestion at depth 2', async () => {
        const fetcher = fakeFetcher({
            seed: ['seed alpha', 'seed beta'],
            'seed alpha': ['seed alpha one', 'seed beta'],
            'seed beta': ['seed beta two'],
        });
        const result = await collectKeyword('seed', { ...base, depth: 2, fetcher });
        expect(fetcher.calls.sort()).toEqual(['seed', 'seed alpha', 'seed beta']);
        const depth2 = result.suggestions.filter((s) => s.modifierType === 'depth2');
        expect(depth2.map((s) => s.suggestion).sort()).toEqual(['seed alpha one', 'seed beta two']);
        expect(depth2[0].modifier).toBe(depth2[0].query);
        expect(result.suggestions).toHaveLength(4);
    });

    it('records a free failure per failed request and keeps the successful ones', async () => {
        const fetcher: Fetcher = async (query) => {
            if (query === 'kw for') {
                throw Object.assign(new Error('HTTP 429 from suggest endpoint'), {
                    errorType: 'rate-limited',
                    statusCode: 429,
                });
            }
            return { suggestions: [suggestion(`${query} x`, 1)], fetchedAt: NOW };
        };
        const result = await collectKeyword('kw', { ...base, expandPrepositions: true, concurrency: 2, fetcher });
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toMatchObject({
            success: false,
            seedKeyword: 'kw',
            query: 'kw for',
            errorType: 'rate-limited',
            statusCode: 429,
        });
        expect(result.suggestions).toHaveLength(8);
    });

    it('returns an empty (but successful) result when Google has no suggestions', async () => {
        const result = await collectKeyword('xqzvvv', { ...base, fetcher: fakeFetcher({}) });
        expect(result.suggestions).toEqual([]);
        expect(result.failures).toEqual([]);
        expect(result.requestsMade).toBe(1);
    });
});

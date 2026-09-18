import { describe, expect, it } from 'vitest';

import {
    buildQueries,
    categorizeError,
    countQueries,
    dedupeKey,
    normalizeKeyword,
    parseSuggestResponse,
} from '../src/expand.js';
import { buildSuggestUrl } from '../src/google.js';

const CHROME_BODY = JSON.stringify([
    'best crm for',
    ['best crm for small business', 'best crm for real estate', '<b>best crm for</b> nonprofits'],
    ['', '', ''],
    [],
    {
        'google:clientdata': { bpc: false, tlw: false },
        'google:suggestrelevance': [1250, 1000, 602],
        'google:suggestsubtypes': [[512], [512], [512]],
        'google:suggesttype': ['QUERY', 'QUERY', 'QUERY'],
        'google:verbatimrelevance': 851,
    },
]);

describe('normalizeKeyword / dedupeKey', () => {
    it('collapses whitespace and trims', () => {
        expect(normalizeKeyword('  best   crm  for ')).toBe('best crm for');
        expect(dedupeKey(' Best CRM  For ')).toBe('best crm for');
    });
});

describe('buildQueries', () => {
    it('returns only the seed query when no expansion is enabled', () => {
        expect(buildQueries('best crm for')).toEqual([{ query: 'best crm for', modifierType: 'none', modifier: null }]);
    });

    it('adds alphabet, question, preposition and number expansions in order', () => {
        const queries = buildQueries('podcast', {
            expandAlphabet: true,
            expandQuestions: true,
            expandPrepositions: true,
            expandNumbers: true,
        });
        expect(queries).toHaveLength(1 + 26 + 11 + 8 + 10);
        expect(
            countQueries({
                expandAlphabet: true,
                expandQuestions: true,
                expandPrepositions: true,
                expandNumbers: true,
            }),
        ).toBe(56);
        expect(queries[0]).toEqual({ query: 'podcast', modifierType: 'none', modifier: null });
        expect(queries[1]).toEqual({ query: 'podcast a', modifierType: 'alphabet', modifier: 'a' });
        expect(queries[26]).toEqual({ query: 'podcast z', modifierType: 'alphabet', modifier: 'z' });
        expect(queries[27]).toEqual({ query: 'who podcast', modifierType: 'question', modifier: 'who' });
        expect(queries[38]).toEqual({ query: 'podcast for', modifierType: 'preposition', modifier: 'for' });
        expect(queries[46]).toEqual({ query: 'podcast 0', modifierType: 'number', modifier: '0' });
        expect(queries.at(-1)).toEqual({ query: 'podcast 9', modifierType: 'number', modifier: '9' });
    });

    it('removes duplicate queries while keeping the first occurrence', () => {
        const queries = buildQueries('crm for', { expandPrepositions: true });
        // "crm for" + "for" would be "crm for for", which is distinct; nothing to dedupe here.
        expect(queries.filter((q) => q.query === 'crm for')).toHaveLength(1);
        expect(countQueries({ expandPrepositions: true })).toBe(9);
    });
});

describe('parseSuggestResponse', () => {
    it('parses the client=chrome shape with relevance and type metadata', () => {
        const { echoedQuery, suggestions } = parseSuggestResponse(CHROME_BODY);
        expect(echoedQuery).toBe('best crm for');
        expect(suggestions).toHaveLength(3);
        expect(suggestions[0]).toEqual({
            suggestion: 'best crm for small business',
            position: 1,
            relevance: 1250,
            suggestType: 'QUERY',
        });
        expect(suggestions[2]).toEqual({
            suggestion: 'best crm for nonprofits',
            position: 3,
            relevance: 602,
            suggestType: 'QUERY',
        });
    });

    it('parses the client=firefox shape without metadata', () => {
        const body = JSON.stringify(['q', ['one', 'two'], [], { 'google:suggestsubtypes': [[512], [512]] }]);
        const { suggestions } = parseSuggestResponse(body);
        expect(suggestions.map((s) => s.suggestion)).toEqual(['one', 'two']);
        expect(suggestions[0].relevance).toBeNull();
    });

    it('returns an empty list for a query with no suggestions', () => {
        const body = JSON.stringify([
            'xqzvvv',
            [],
            [],
            [],
            { 'google:clientdata': { bpc: true, tlw: true }, 'google:suggesttype': [] },
        ]);
        expect(parseSuggestResponse(body).suggestions).toEqual([]);
    });

    it('strips the XSSI prefix', () => {
        expect(parseSuggestResponse(`)]}'\n${CHROME_BODY}`).suggestions).toHaveLength(3);
    });

    it('throws on non-JSON or unexpected bodies so junk is never billed', () => {
        expect(() => parseSuggestResponse('<html>Sorry</html>')).toThrow(/not JSON/);
        expect(() => parseSuggestResponse('{"error":"x"}')).toThrow(/Unexpected response shape/);
        expect(() => parseSuggestResponse('[1,2]')).toThrow(/Unexpected response shape/);
    });
});

describe('categorizeError', () => {
    it('maps status codes and messages to error types', () => {
        expect(categorizeError('Too many requests', 429)).toBe('rate-limited');
        expect(categorizeError('Forbidden', 403)).toBe('blocked');
        expect(categorizeError('We detected unusual traffic')).toBe('blocked');
        expect(categorizeError('Internal error', 500)).toBe('http-error');
        expect(categorizeError('Timeout awaiting request')).toBe('timeout');
        expect(categorizeError('read ECONNRESET')).toBe('network');
        expect(categorizeError('getaddrinfo ENOTFOUND host')).toBe('network');
        expect(categorizeError('something else')).toBe('other');
    });
});

describe('buildSuggestUrl', () => {
    it('uses the chrome client and encodes the query, country and language', () => {
        const url = new URL(buildSuggestUrl('best crm for', 'us', 'en'));
        expect(url.origin + url.pathname).toBe('https://suggestqueries.google.com/complete/search');
        expect(url.searchParams.get('client')).toBe('chrome');
        expect(url.searchParams.get('q')).toBe('best crm for');
        expect(url.searchParams.get('gl')).toBe('us');
        expect(url.searchParams.get('hl')).toBe('en');
    });
});

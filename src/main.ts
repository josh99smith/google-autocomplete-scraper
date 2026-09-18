import { setTimeout as sleep } from 'node:timers/promises';

import { Actor, log, type ProxyConfigurationOptions } from 'apify';

import { collectKeyword, type FailureRecord } from './collect.js';
import { countQueries, normalizeKeyword } from './expand.js';
import { fetchSuggestions } from './google.js';

const CHARGE_EVENT = 'keyword-queried';
/** Give up on the whole run after this many consecutive seed keywords that failed completely. */
const MAX_CONSECUTIVE_FAILED_KEYWORDS = 3;

interface Input {
    keywords?: (string | { keyword?: string; query?: string })[];
    country?: string;
    language?: string;
    expandAlphabet?: boolean;
    expandQuestions?: boolean;
    expandPrepositions?: boolean;
    expandNumbers?: boolean;
    maxSuggestionsPerKeyword?: number;
    depth?: number;
    maxConcurrency?: number;
    maxRetries?: number;
    proxyConfiguration?: ProxyConfigurationOptions & { useApifyProxy?: boolean };
}

await Actor.init();

Actor.on('aborting', async () => {
    await sleep(1000);
    await Actor.exit();
});

const input = (await Actor.getInput<Input>()) ?? {};

const rawKeywords = (input.keywords ?? []).map((k) => (typeof k === 'string' ? k : (k?.keyword ?? k?.query ?? '')));
if (rawKeywords.length === 0) {
    await Actor.fail('Input "keywords" is empty. Provide at least one seed keyword, e.g. ["best crm for"].');
}

const country = (input.country ?? 'us').trim().toLowerCase();
const language = (input.language ?? 'en').trim();
if (!/^[a-z]{2}$/.test(country)) {
    await Actor.fail(
        `Input "country" must be a two-letter country code such as "us" or "de" (got "${input.country}").`,
    );
}
if (!/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(language)) {
    await Actor.fail(`Input "language" must be a language code such as "en" or "pt-BR" (got "${input.language}").`);
}

const expansions = {
    expandAlphabet: input.expandAlphabet ?? false,
    expandQuestions: input.expandQuestions ?? false,
    expandPrepositions: input.expandPrepositions ?? false,
    expandNumbers: input.expandNumbers ?? false,
};
const maxSuggestionsPerKeyword = Math.min(Math.max(Math.floor(input.maxSuggestionsPerKeyword ?? 50), 1), 5000);
const depth = (input.depth ?? 1) >= 2 ? 2 : 1;
const concurrency = Math.min(Math.max(Math.floor(input.maxConcurrency ?? 3), 1), 5);
const maxRetries = Math.min(Math.max(Math.floor(input.maxRetries ?? 2), 0), 5);

// Normalise and dedupe the seed keywords; empty entries are reported as free failures.
const seen = new Set<string>();
const keywords: string[] = [];
const invalidFailures: FailureRecord[] = [];
for (const raw of rawKeywords) {
    const keyword = normalizeKeyword(String(raw ?? ''));
    if (!keyword) {
        invalidFailures.push({
            success: false,
            seedKeyword: String(raw ?? ''),
            query: '',
            errorType: 'other',
            error: 'Empty keyword',
            fetchedAt: new Date().toISOString(),
        });
        continue;
    }
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(keyword);
}
if (invalidFailures.length) await Actor.pushData(invalidFailures);
if (keywords.length === 0) {
    await Actor.fail('Input "keywords" contains no usable keywords (all entries were empty).');
}

const proxyConfiguration =
    input.proxyConfiguration?.useApifyProxy || input.proxyConfiguration?.proxyUrls?.length
        ? await Actor.createProxyConfiguration(input.proxyConfiguration)
        : undefined;

const perKeywordRequests = countQueries(expansions);
log.info(
    `Processing ${keywords.length} seed keyword(s) for gl=${country} hl=${language}: ` +
        `${perKeywordRequests} request(s) per keyword at depth 1` +
        `${depth === 2 ? ', plus one request per suggestion found (depth 2)' : ''}, ` +
        `max ${maxSuggestionsPerKeyword} suggestions per keyword, concurrency ${concurrency}${proxyConfiguration ? ', via Apify Proxy' : ''}.`,
);

const chargingManager = Actor.getChargingManager();
const { isPayPerEvent } = chargingManager.getPricingInfo();

let keywordsCharged = 0;
let keywordsProcessed = 0;
let keywordsFailed = 0;
let suggestionsFound = 0;
let failures = invalidFailures.length;
let requestsMade = 0;
let stoppedEarlyDueToBudget = false;
let stoppedEarlyDueToErrors = false;
let consecutiveFailedKeywords = 0;

for (const seedKeyword of keywords) {
    // Never start work that cannot be billed.
    if (isPayPerEvent && chargingManager.calculateMaxEventChargeCountWithinLimit(CHARGE_EVENT) <= 0) {
        stoppedEarlyDueToBudget = true;
        log.warning(
            `Maximum charge limit for this run reached before "${seedKeyword}"; stopping early. ` +
                `${keywords.length - keywordsProcessed} keyword(s) were not processed. Raise the run cost limit to continue.`,
        );
        break;
    }

    const result = await collectKeyword(seedKeyword, {
        ...expansions,
        country,
        language,
        depth,
        maxSuggestionsPerKeyword,
        concurrency,
        fetcher: async (query) =>
            fetchSuggestions(query, {
                country,
                language,
                maxRetries,
                getProxyUrl: proxyConfiguration ? async () => proxyConfiguration.newUrl() : undefined,
            }),
    });
    keywordsProcessed += 1;
    requestsMade += result.requestsMade;

    if (result.suggestions.length) await Actor.pushData(result.suggestions); // no event name: the seed keyword is the billable unit
    if (result.failures.length) await Actor.pushData(result.failures); // free of charge
    suggestionsFound += result.suggestions.length;
    failures += result.failures.length;

    const failureTypes = [...new Set(result.failures.map((f) => f.errorType))];
    if (result.failures.length === 0) {
        // Every request for this keyword completed (empty results still count: the queries ran).
        const { eventChargeLimitReached, chargedCount } = await Actor.charge({ eventName: CHARGE_EVENT });
        keywordsCharged += chargedCount;
        consecutiveFailedKeywords = 0;
        log.info(
            `"${seedKeyword}": ${result.suggestions.length} unique suggestion(s) from ${result.requestsMade} request(s)` +
                `${result.requestsSkipped ? `, ${result.requestsSkipped} skipped after reaching the limit` : ''}.`,
        );
        if (eventChargeLimitReached) {
            stoppedEarlyDueToBudget = true;
            const remaining = keywords.length - keywordsProcessed;
            if (remaining > 0) {
                log.warning(
                    `Maximum charge limit for this run reached; stopping early. ${remaining} keyword(s) were not processed. Raise the run cost limit to continue.`,
                );
            }
            break;
        }
    } else {
        // Not charged: at least one request failed, so the keyword was not fully processed.
        keywordsFailed += 1;
        log.warning(
            `"${seedKeyword}": NOT charged - ${result.failures.length} of ${result.requestsMade} request(s) failed (${failureTypes.join(', ')}); ` +
                `${result.suggestions.length} suggestion(s) saved for free.`,
        );
        const fullyFailed = result.suggestions.length === 0;
        const throttled = failureTypes.some((t) => t === 'rate-limited' || t === 'blocked');
        consecutiveFailedKeywords = fullyFailed ? consecutiveFailedKeywords + 1 : 0;
        if (
            throttled &&
            keywordsProcessed < keywords.length &&
            consecutiveFailedKeywords < MAX_CONSECUTIVE_FAILED_KEYWORDS
        ) {
            log.warning(
                'Google is rate-limiting or blocking requests; pausing for 10 s before the next keyword. Consider enabling Apify Proxy.',
            );
            await sleep(10_000);
        }
        if (consecutiveFailedKeywords >= MAX_CONSECUTIVE_FAILED_KEYWORDS) {
            stoppedEarlyDueToErrors = true;
            log.error(
                `${MAX_CONSECUTIVE_FAILED_KEYWORDS} consecutive keywords failed completely; stopping the run to avoid hammering the endpoint.`,
            );
            break;
        }
    }
}

const summary = {
    keywordsRequested: rawKeywords.length,
    keywordsProcessed,
    keywordsCharged: isPayPerEvent ? keywordsCharged : keywordsProcessed - keywordsFailed,
    keywordsFailed,
    suggestionsFound,
    failures,
    requestsMade,
    country,
    language,
    depth,
    stoppedEarlyDueToBudget,
    stoppedEarlyDueToErrors,
};
await Actor.setValue('SUMMARY', summary);
log.info(`Done. ${JSON.stringify(summary)}`);

await Actor.exit();

Collect **Google Autocomplete keyword suggestions** for any list of seed keywords, in any country and language. Type `best crm for` into Google and you see ten to fifteen phrases that real people search for; this Actor fetches those phrases for hundreds of seeds at once, expands them with a-z, question, preposition and number modifiers, and hands you a clean, deduplicated keyword list as JSON, CSV or Excel.

It is built for **SEO specialists, content marketers and product researchers** who need long-tail keyword ideas and question-style queries without paying for a keyword-tool subscription. You pay a flat price per seed keyword, and keywords that could not be queried are reported **free of charge**.

## What can you do with Google Autocomplete Keyword Scraper?

- **Long-tail keyword research**: turn one head term into hundreds of specific phrases (`best crm for real estate agents`, `best crm for nonprofits`, ...).
- **Question mining**: prefix your topic with who / what / when / where / why / how / can / is / are / does / will to find the questions people actually type, similar to a "People Also Ask" list, ready for FAQ pages and blog outlines.
- **Content planning**: use depth 2 to follow each suggestion one step further and build topic clusters around a pillar page.
- **Local and international SEO**: run the same seeds for `gl=de`, `gl=in`, `gl=br` and the matching language to see how demand differs by market.
- **Feed AI agents and pipelines** through the Apify API and MCP server.

## How it works

For every seed keyword the Actor calls Google's public autocomplete endpoint (the same one the search box uses), parses the JSON reply and stores each suggestion together with its position and Google's relevance score. Enabled expansions send additional queries (`<keyword> a` ... `<keyword> z`, `how <keyword>`, `<keyword> vs`, `<keyword> 2`, ...), and depth 2 re-queries every suggestion found at depth 1 once. Results are deduplicated per seed keyword.

Requests are sent with low concurrency and small random delays to stay polite. Suggestions change by country, language and time, so two runs are not guaranteed to be identical; rare phrases may return few or no suggestions. No search result pages are scraped and no personal data is collected.

## How to use it

1. Open the Actor and enter your seed keywords in **Seed keywords**, one per line. Partial phrases (`best crm for`, `how to start a podcast`) work best.
2. Set **Country** and **Language** for the market you are researching (defaults: `us` / `en`).
3. Optionally enable **Expand with a-z**, **question words**, **prepositions** or **numbers**, and set **Depth** to `2` for a deeper crawl.
4. Click **Start**. Suggestions appear in the **Output** tab as each keyword finishes.
5. Download the dataset as JSON, CSV, Excel or XML, or connect it to Google Sheets, Airtable, Zapier or Make.

```json
{
    "keywords": ["best crm for", "how to start a podcast"],
    "country": "us",
    "language": "en",
    "expandQuestions": true,
    "maxSuggestionsPerKeyword": 50,
    "depth": 1
}
```

## Output

One record per unique suggestion:

```json
{
    "success": true,
    "seedKeyword": "best crm for",
    "query": "what best crm for",
    "suggestion": "what's the best crm for small business",
    "position": 1,
    "relevance": 601,
    "suggestType": "QUERY",
    "modifierType": "question",
    "modifier": "what",
    "country": "us",
    "language": "en",
    "fetchedAt": "2026-09-18T19:45:58.767Z"
}
```

Requests that fail are recorded too, so nothing silently disappears:

```json
{
    "success": false,
    "seedKeyword": "best crm for",
    "query": "best crm for k",
    "errorType": "rate-limited",
    "error": "HTTP 429 from suggest endpoint",
    "statusCode": 429,
    "fetchedAt": "..."
}
```

The run also stores a `SUMMARY` record in the key-value store with `keywordsRequested`, `keywordsCharged`, `suggestionsFound`, `failures` and `requestsMade`.

### Fields

| Field                 | Description                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `seedKeyword`         | The keyword from your input that this suggestion belongs to.                                                  |
| `query`               | The exact query sent to Google (seed plus modifier, or a depth-1 suggestion when `modifierType` is `depth2`). |
| `suggestion`          | The autocomplete suggestion text.                                                                             |
| `position`            | 1-based position of the suggestion in Google's reply for that query.                                          |
| `relevance`           | Google's relevance score for the suggestion (higher is more popular); may be `null`.                          |
| `suggestType`         | Google's suggestion type, usually `QUERY`.                                                                    |
| `modifierType`        | `none`, `alphabet`, `question`, `preposition`, `number` or `depth2`.                                          |
| `modifier`            | The letter, word or digit that was added, or the re-queried suggestion for `depth2`.                          |
| `country`, `language` | The `gl` and `hl` values used.                                                                                |
| `errorType`           | For failures: `rate-limited`, `blocked`, `timeout`, `network`, `http-error` or `other`.                       |

## Pricing: how much does it cost to scrape Google Autocomplete suggestions?

You pay a **flat price per seed keyword** (shown next to the Start button). The price covers every expansion and depth-2 request for that keyword, however many suggestions it produces; 15 suggestions or 1,000 cost the same. A keyword whose requests fail because of rate limiting or a network error is **not charged** and is reported with an `errorType` instead. Keywords that legitimately return zero suggestions are charged, because the queries did run.

There is no charge for Actor start-up, and the Actor stops automatically when it reaches the maximum cost you set for a run, so a large keyword list never produces a surprise bill.

## Tips

- **Expansions multiply requests.** Each seed keyword sends 1 request by default; a-z adds 26, question words 11, prepositions 8 and numbers 10 (all four together: 56 requests per keyword). Depth 2 adds one request per suggestion found at depth 1. The price per keyword stays the same, but runs take longer.
- **Use the cap.** `maxSuggestionsPerKeyword` stops sending requests for a keyword as soon as the limit is hit, which keeps depth-2 runs fast. In testing, `best crm for` with a-z + prepositions + depth 2 produced 1,000 unique suggestions from 188 requests in about 35 seconds.
- **Question mining works best with a topic, not a full question.** Seed `start a podcast` rather than `how to start a podcast`.
- **Rate limits.** Google tolerates a few requests per second from one IP. Keep **Max concurrency** at the default (3) and enable **Apify Proxy** in the Advanced section if you see `rate-limited` failures on big runs. Proxy traffic is billed separately by Apify.
- **Schedule it** to track how suggestions for your brand change week over week.

## FAQ

**Are these the same suggestions I see in the Google search box?**
Yes, they come from the same public autocomplete endpoint, using the `client=chrome` mode, which returns up to 15 suggestions plus relevance scores. Suggestions are personalised in a signed-in browser, so what you see may differ slightly from the unpersonalised results the Actor collects.

**Does it return search volume?**
No. Google Autocomplete does not expose volumes. The `relevance` score is Google's own ranking signal for the suggestion list and is useful for ordering, not for estimating traffic.

**Is this legal?**
The Actor reads a public, unauthenticated endpoint at a low request rate, stores only the suggestion text Google publishes, and collects no personal data. You are responsible for using the results in compliance with the laws and terms that apply to you.

## Support and feedback

Found a problem or need another modifier set (for example comparison words in your language)? Open a ticket in the **Issues** tab of this Actor. The source code is available under the MIT licence.

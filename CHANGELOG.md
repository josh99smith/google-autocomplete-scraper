# Changelog

## 0.1.1 (2026-09-20)

- Fixed: an input list containing the same keyword twice was rejected by input validation with a confusing error. Duplicates are now removed by the Actor, as the description always said.

## 0.1.0 (2026-09-18)

- Initial release: Google Autocomplete suggestions per seed keyword via the public suggest endpoint (`client=chrome`, includes relevance scores).
- Optional alphabet (a-z), question, preposition and number expansions, plus depth 2 (re-query every suggestion once).
- Per-keyword deduplication, country/language targeting, optional Apify Proxy.
- Pay-per-event pricing: one charge per seed keyword; failed keywords are reported for free.

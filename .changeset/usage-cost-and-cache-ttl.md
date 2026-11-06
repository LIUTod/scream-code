---
"scream-code": patch
---

`/usage` now shows money. The model catalog's per-token prices (USD per 1M tokens, published by models.dev) are kept instead of dropped at parse time, each usage bucket is priced at its own rate — plain input, cache reads, cache writes, output — and the usage panel renders a session total plus a per-model suffix. Unpriced models show `—` rather than `$0.00`, which would read as free.

Anthropic prompt-cache breakpoints gain a `cacheRetention` setting: the default stays the 5-minute tier, `long` selects the 1-hour tier and adds the `extended-cache-ttl-2025-04-11` beta header, aimed at sessions that idle longer than five minutes between turns.

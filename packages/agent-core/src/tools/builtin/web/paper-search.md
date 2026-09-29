Search the academic literature — arXiv, OpenAlex, Crossref and Europe PMC — and return paper metadata with links.

Use it for research questions: prior work, methods, benchmarks, "has anyone studied X", literature reviews, or whenever an answer should be grounded in published literature rather than blog posts. `WebSearch` stays the right tool for current events, product documentation and general web pages; the two are complementary, not alternatives.

Input notes:

- `query` is a topical phrase, not a URL or a citation. Use the field's own vocabulary; a full sentence works poorly.
- `limit` (1–20, default 5) caps the merged result count. For breadth, raise it slightly — then refine the query rather than paging.
- `sort`: `relevance` (default) keeps each source's own relevance order; `date` puts the newest work first across all sources.
- `category` is an **arXiv category** filter (e.g. `cs.AI`, `cs.CL`, `stat.ML`); it is ignored by the other sources.
- `year_from` drops older work (applies to every source).
- `sources` narrows the query to a subset of `arxiv`, `openalex`, `crossref`, `europepmc`. Omit it unless a source keeps failing and you want it out of the way.

Sources are queried in parallel and merged; duplicate records are collapsed. A source that is unreachable, rate-limited or blocked is reported in a trailing `Note:` line — the remaining sources still answer, so a partial result is normal. Surface that gap to the user when it matters.

Rules:

- Cite only what this tool returns. Never invent a title, author, DOI, venue or arXiv id, and never fill a gap from memory.
- The tool returns **metadata and links only**. To read a paper, open its `URL` (or `PDF`) with `FetchURL` — never claim to have read a paper you did not fetch.
- An abstract is the authors' own summary: attribute it to the paper instead of stating it as established fact.

---
"scream-code": patch
---

`/knowledge` can now ingest PDF, Word (.docx) and Excel (.xlsx) files alongside Markdown and plain text. Binary documents are converted to Markdown by the document engine that already ships with the runtime, then follow the exact same chunking and embedding path as a `.md` file, so the shared vector index and `/memory` are unaffected.

Details:

- The converter engine moved into the knowledge package (no new dependencies, no new package). It is imported lazily, so startup and `/memory` searches never pay for it.
- Images are dropped and their placeholders stripped; a document with no text layer (scanned PDF) fails with a clear message instead of storing an empty record.
- Documents are fingerprinted by their raw bytes, so an identical file is skipped and a changed one is re-ingested.
- Directory ingestion skips hidden entries, Office lock files (`~$…`) and unsupported formats.
- Ingest prompts now recommend Markdown first and warn that scans, image-heavy files and wide tables extract poorly.

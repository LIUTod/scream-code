---
"scream-code": patch
---

Fix the embedding-model setup card reappearing on every startup on installs without a pre-existing model cache. The pinned model archive is now staged by the app itself from a first-party GitHub release with HTTP status validation and an on-disk sha256 check, instead of relying on the third-party model mirror that stopped serving anonymous downloads — its downloader never checks the response status, so a 403 error page used to be silently written into the staged archive and every subsequent extract failed. Lint ratchet baseline lowered to the new low.

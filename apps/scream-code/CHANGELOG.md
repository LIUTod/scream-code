# scream-code

## 0.16.9

### Patch Changes

- [#18](https://github.com/LIUTod/scream-code/pull/18) [`2fda5b7`](https://github.com/LIUTod/scream-code/commit/2fda5b7ce50f060d09875a54f35f26e5fa7d8c58) - Recover explicit status codes from OpenAI-compatible streaming errors and classify status-less provider messages so transient failures enter the existing retry policy instead of immediately failing agent tasks.

- [`dbbf1d6`](https://github.com/LIUTod/scream-code/commit/dbbf1d6f59f0123dd263f69c2583e8bd534ca67a) - Support an optional per-provider session header that carries the stable conversation id, stamp known catalog entries when connecting, and surface an actionable config hint when a gateway reports a missing session header.

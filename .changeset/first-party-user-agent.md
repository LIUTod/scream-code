---
"scream-code": patch
---

Send the product user agent with requests to third-party model endpoints. The identity used to be attached only to providers configured with a session header, so most OpenAI-compatible and Anthropic endpoints saw the SDK's own library user agent instead of the product's. Device fingerprint headers remain host-scoped and are not forwarded to third-party endpoints.

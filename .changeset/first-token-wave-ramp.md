---
"scream-code": patch
---

The status-bar pulse wave now reports silence. While the agent is working but receiving nothing — a request awaiting its first token, a reasoning or text stream that stopped delivering, or a tool that has been running without progress — the wave ramps from the brand colour toward amber, reaching pure amber at 15s and pure red at 25s, then stays red. Any inbound event returns it to the brand colour immediately.

A retry floors the wave at amber, so a known failure never renders next to a "reconnecting" label while the wave still claims everything is healthy. Switching sessions clears the work phase and the liveness clock, so a new session cannot inherit a stalled indicator.

Red is an early warning only: retries still come from real transport failures (the stall timeout, disconnects, rate limits). Colours come from the active palette (`primary` / `warning` / `error`), so light and dark themes each ramp between their own contrast-checked values, and a live theme switch repaints the wave on the next frame.

---
"scream-code": patch
---

The status-bar pulse wave no longer reads a quiet tool call as a dead connection. It used to ramp from green to deep red after 25s of silence whenever the phase was not `执行中` — which caught the whole `调用中` window, so a long command being authored looked like a failure while it was fine. The wave now asks whether a tool call is actually in flight (`StreamingUIController.hasInFlightToolCalls()`, which counts argument previews as well as started calls) and keeps the brand colour for that call's entire lifetime, wherever the phase happens to be. A late argument preview can also no longer overwrite a call that already started, so a running command cannot regress to `调用中` and re-arm the ramp mid-execution. The silence ramp still covers the pure model phases (`等待响应` / `思考中` / `输出中`).

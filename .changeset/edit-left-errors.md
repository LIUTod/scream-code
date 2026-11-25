---
"@scream-code/agent-core": patch
"scream-code": patch
---

An Edit or Write that applied but left type errors is no longer reported as a failed call. The change happened, so the result is a success: the activity block shows its diff instead of a ✗ with nothing under it, and the model is not taught that Edit does not work. The language server's report is still in the result, and before the turn ends the model is still reminded to fix the errors it left.

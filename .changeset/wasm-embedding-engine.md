---
"scream-code": patch
---

Move the local embedding engine off native binaries onto a self-contained WebAssembly pipeline. Installing no longer pulls a compiler toolchain or an unused GPU runtime on Linux (and can no longer lose the whole vector feature when that download fails), the dependency tree drops its deprecated packages, and the model download now reports byte progress with stall and overall timeout guards plus verify/load phases. A cache is only considered installed when the weights and both tokenizer files are present, so a half-restored cache repairs itself instead of failing at load time. Vectors are bit-compatible with the previous engine.

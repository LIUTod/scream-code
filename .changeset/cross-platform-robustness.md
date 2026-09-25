---
"scream-code": patch
---

Make the agent behave consistently on macOS, Linux and Windows. The bundled ripgrep binary is now picked by probing the host libc instead of inferring it from the CPU architecture, Windows falls back to PowerShell when Git Bash is absent, and command execution resolves `.cmd`/`.bat` shims through `PATHEXT` rather than relying on a shell. Timed-out hooks and update steps terminate the whole process tree on Windows. Path safety checks understand Windows drive letters and UNC paths, the external editor no longer assumes a POSIX shell, and installing the package no longer hard-fails on platforms without a prebuilt local-embedding binary. State files are located through the shared home resolver and written atomically.

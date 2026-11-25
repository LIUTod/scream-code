---
"scream-code": patch
---

**An upgrade now reaches the background.** It used to keep running the build it had loaded until something restarted it, so a fix you installed seemed to do nothing. A terminal of the newer build now restarts the background as soon as it is idle (asking again every few minutes while it works) and says `后台已更新到 <version>`; with the resident service, the service starts the installed build. Only an older background is restarted, so a terminal left open from before the upgrade never takes it back down.

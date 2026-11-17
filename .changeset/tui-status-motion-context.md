---
"scream-code": patch
---

Status row, context gauge and animation fixes.

- The status row above the editor no longer loses information on narrow terminals. It used to be hard-truncated, so an MCP notice became `🔌 ...` at 40 columns and the idle tip vanished whenever a reminder was showing. Segments now yield by priority — pulse wave (never dropped), scheduled-task reminder, collaboration ticker, MCP notice, tip — and a chip that cannot keep at least 10 columns is dropped whole instead of showing a bare `...`; one that can is cut with a single `…`. Wide terminals render exactly as before.
- The context gauge turns yellow/red on the used share or an absolute token count, whichever comes first: yellow at 60% or 400K tokens, red at 90% or 700K. On a 1M window that is 400K/700K instead of 600K/900K (auto-compaction runs at 85%); on 200K/256K windows nothing changes.
- Animations have one switch and one cadence knob. `SCREAM_MOTION=off` — or `SCREAM_REDUCED_MOTION=1`, which used to affect only the streaming fade — now stops every decorative animation: the status-bar wave, the thinking, tool-call and background-agent spinners, the compaction blink, the approval and question pulses, the welcome breathing, the balance flash and the footer glow. `SCREAM_SPINNER_INTERVAL_MS` sets the spinner period for all of them (`0` = still, otherwise a whole number of ms >= 50). Invalid values are ignored. With motion off the footer's elapsed and goal clocks keep counting (repainted once a second) and the work status shows a steady dot. Useful over slow SSH links and in recordings.

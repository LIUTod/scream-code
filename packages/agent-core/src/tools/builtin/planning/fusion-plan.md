Generate an implementation plan by spawning multiple planning subagents in parallel, each from a different angle (correctness, minimal invasiveness, architecture), and synthesizing their outputs into a single plan.

Use this tool when you are in fusion plan mode (entered via `EnterPlanMode(mode='fusion')` or when the plan strategy is 'fusion'). Do NOT write the plan manually — call FusionPlan instead.

The tool writes the synthesized plan directly to the plan file. After it completes, review the plan and call ExitPlanMode for user approval.

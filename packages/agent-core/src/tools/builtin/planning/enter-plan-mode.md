Use this tool proactively when you're about to start a non-trivial implementation task: getting user sign-off on your approach via ExitPlanMode before writing code prevents wasted effort.

## Planning Modes

- **Normal plan**: investigate the codebase, design a single approach, write it to the plan file, then present it for approval.
- **Fusion plan**: call the FusionPlan tool to spawn parallel planning subagents that each explore a different angle, then synthesize their output into one plan. Slower, but it tends to surface risks and alternatives you would otherwise miss.

Prefer **normal plan** for specific detailed instructions, small or localized changes (1-3 files), a codebase you know well, or when speed matters; prefer **fusion plan** for open-ended or ambiguous tasks ("improve performance", "refactor auth"), multiple valid architectures, changes spanning more than 3-5 files or touching core abstractions, and when you want parallel exploration. If unsure: normal for small fixes, fusion for larger design tasks.

## When to Use

Use it when any of these apply: new feature implementation; multiple valid approaches; code modifications to existing modules; architectural decisions; multi-file changes (more than 2-3 files); unclear requirements that need exploration; decisions where the user's preference would materially change the approach.

Permission mode notes:
- EnterPlanMode enters plan mode automatically, without an approval prompt, in all permission modes.
- In yolo and manual modes, ExitPlanMode still presents the plan to the user for approval; in auto permission mode it exits without asking, and you should not use AskUserQuestion there — decide from the available context.
- Use EnterPlanMode only when planning itself adds value.

When NOT to use: single-line or few-line fixes (typos, obvious bugs, small tweaks), very specific detailed instructions from the user, or pure research/exploration tasks.

## What Happens in Plan Mode

1. Identify the 2-3 key questions about the codebase that are critical to your plan. If you are not confident about the structure or the relevant code paths, use `Agent(subagent_type="explore")` to investigate them first — strongly recommended for non-trivial tasks.
2. Do the remaining quick lookups with Glob, Grep, Read and the other read-only tools; use Bash only when needed (it follows the normal permission mode and rules).
3. Design the implementation approach from your findings — for fusion plan, call FusionPlan to generate the synthesized plan.
4. Review the plan, fill in any gaps, check it matches the user's intent, then present it via ExitPlanMode for approval.

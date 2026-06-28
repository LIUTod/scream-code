Use this tool proactively when you're about to start a non-trivial implementation task.
Getting user sign-off on your approach via ExitPlanMode before writing code prevents wasted effort.

## Planning Modes

The host supports two planning strategies. You can request either one via this tool:

- **Normal plan** (default): You investigate the codebase, design a single implementation approach, write it to the plan file, and present it for approval. Best when the task is straightforward or you are already confident about the right approach.
- **Fusion plan**: The host spawns multiple independent planning subagents in parallel, each exploring a different angle, then synthesizes their outputs into one consolidated plan. Best when the task is ambiguous, has many valid approaches, crosses many files, or when exploration itself adds significant value. Fusion plan may take longer but tends to surface risks and alternatives you might miss.

To request a fusion plan, include `mode: 'fusion'` in your tool arguments. If you omit `mode` or set it to `normal`, the host uses the normal plan flow.

### When to choose which mode

Prefer **normal plan** when:
1. The user gave specific, detailed instructions.
2. The change is small or localized (1-3 files, single concern).
3. You are confident about the codebase structure and the right approach.
4. Speed matters more than exploring alternatives.

Prefer **fusion plan** when:
1. The task is open-ended or ambiguous (e.g. "improve performance", "refactor auth").
2. Multiple valid architectures or approaches exist.
3. The change spans more than 3-5 files or touches core abstractions.
4. You are unfamiliar with the relevant code paths and want parallel exploration.
5. The user explicitly asked for a thorough plan or mentioned comparing options.

If unsure, choose normal plan for small fixes and fusion plan for larger design tasks.

## When to Use

Use this tool when ANY of these conditions apply:

1. New Feature Implementation - e.g. "Add a caching layer to the API"
2. Multiple Valid Approaches - e.g. "Optimize database queries" (indexing vs rewrite vs caching)
3. Code Modifications - e.g. "Refactor auth module to support OAuth"
4. Architectural Decisions - e.g. "Add WebSocket support"
5. Multi-File Changes - involves more than 2-3 files
6. Unclear Requirements - need exploration to understand scope
7. User Preferences Matter - if user input would materially change the implementation approach, use EnterPlanMode to structure the decision

Permission mode notes:
- EnterPlanMode enters plan mode automatically without an approval prompt in all permission modes.
- In yolo and manual modes, ExitPlanMode still presents the plan to the user for approval.
- In auto permission mode, do not use AskUserQuestion; make the best decision from available context.
- In auto permission mode, ExitPlanMode exits plan mode without asking the user.
- Use EnterPlanMode only when planning itself adds value.

When NOT to use:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- User gave very specific, detailed instructions
- Pure research/exploration tasks

## What Happens in Plan Mode
In plan mode, you will:
1. Identify 2-3 key questions about the codebase that are critical to your plan. If you are not confident about the codebase structure or relevant code paths, use `Agent(subagent_type="explore")` to investigate these questions first - this is strongly recommended for non-trivial tasks.
2. Explore the codebase using Glob, Grep, Read, and other read-only tools for any remaining quick lookups. Use Bash only when needed; Bash follows the normal permission mode and rules.
3. Design an implementation approach based on your findings (or, for fusion plan, review the synthesized plan the host provides).
4. Write the plan to the current plan file with Write or Edit.
5. Present your plan to the user via ExitPlanMode for approval

For fusion plan, the host performs the parallel exploration and synthesis for you; you should still review the result, fill in any gaps, and ensure it matches the user's intent before exiting plan mode.

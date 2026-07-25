Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode reminder.
- This tool does NOT take the plan content as a parameter - it reads the plan from the file you wrote.
- The user will see the contents of your plan file when they review it. In auto permission mode, the tool reads the file and exits plan mode without asking the user.

## When to Use
Only use this tool for tasks that require planning implementation steps. For research tasks (searching files, reading code, understanding the codebase), do NOT use this tool.

## Multiple Approaches
If your plan contains multiple alternative approaches:
- If you recommend one option, append "(Recommended)" to its label.
- In yolo and manual modes, the user will see all options alongside Reject and Revise choices.
- Passing a single option is allowed and is equivalent to a plain plan approval (no approach choice is surfaced to the user).

## Before Using
- In auto permission mode, do NOT use AskUserQuestion; make the best decision from available context.
- In auto permission mode, this tool exits plan mode without asking the user.
- In yolo and manual modes, this tool still presents the plan to the user for approval.
- If auto permission mode is not active and you have unresolved questions, use AskUserQuestion first.
- If auto permission mode is not active and you have multiple approaches and haven't narrowed down yet, consider using AskUserQuestion first to let the user choose, then write a plan for the chosen approach only.
- Once your plan is finalized, use THIS tool to request approval.
- Do NOT use AskUserQuestion to ask "Is this plan OK?" or "Should I proceed?" - that is exactly what ExitPlanMode does.
- If rejected, revise based on feedback and call ExitPlanMode again.

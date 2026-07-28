/**
 * TodoListTool — structured TODO list management tool.
 *
 * The LLM uses this tool to maintain a visible plan of sub-tasks during
 * plan-mode workflows and multi-step operations. A single tool serves
 * both reads and writes:
 *
 *   - `resolveExecution({ todos: [...] })` — replace the full list
 *   - `resolveExecution({ todos: [] })`    — clear the list
 *   - `resolveExecution({})`               — query current list (no mutation)
 *
 * Storage: todos live in the agent-level tool store. Writes go through
 * `tools.update_store`, so the store update is visible on wire replay.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import type { TodoItem, TodoStatus } from '../../../todo';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ToolStore } from '../../store';
import DESCRIPTION from './todo-list.md';

const TODO_STORE_KEY = 'todo';

// ── Schema ───────────────────────────────────────────────────────────

const TodoItemSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe('Short, actionable title for the todo. Required field name is `title`, not `content` or `name`.'),
  status: z.enum(['pending', 'in_progress', 'done']).describe('Current status of the todo.'),
  phase: z
    .string()
    .optional()
    .describe(
      'Optional phase/group for the todo. Items in the same phase are rendered together. Complete one phase before starting the next.',
    ),
});

export interface TodoListInput {
  todos?: Array<{ title: string; status: TodoStatus; phase?: string }>;
}

export const TodoListInputSchema: z.ZodType<TodoListInput> = z.object({
  todos: z
    .array(TodoItemSchema)
    .max(200)
    .optional()
    .describe(
      'The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.',
    ),
});


// ── Implementation ───────────────────────────────────────────────────

function renderTodoList(todos: readonly TodoItem[]): string {
  if (todos.length === 0) {
    return 'Todo list is empty.';
  }

  // Preserve input order within each phase while grouping by phase.
  const groups = new Map<string | undefined, TodoItem[]>();
  for (const todo of todos) {
    const key = todo.phase ?? undefined;
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
    }
    group.push(todo);
  }

  const lines: string[] = ['Current todo list:'];
  for (const [phase, items] of groups) {
    if (phase !== undefined) {
      lines.push(`\n## ${phase}`);
    }
    for (const item of items) {
      const marker = statusMarker(item.status);
      lines.push(`  ${marker} ${item.title}`);
    }
  }
  return lines.join('\n');
}

function statusMarker(status: TodoStatus): string {
  switch (status) {
    case 'pending':
      return '[pending]';
    case 'in_progress':
      return '[in_progress]';
    case 'done':
      return '[done]';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export class TodoListTool implements BuiltinTool<TodoListInput> {
  readonly name = 'TodoList' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TodoListInputSchema);

  constructor(private readonly store: ToolStore) {}

  resolveExecution(args: TodoListInput): ToolExecution {
    const description =
      args.todos === undefined
        ? 'Reading todo list'
        : args.todos.length === 0
          ? 'Clearing todo list'
          : 'Updating todo list';
    return {
      description,
      approvalRule: this.name,
      execute: async () => {
        // Query mode — return the current list without mutation.
        if (args.todos === undefined) {
          const current = this.getTodos();
          return { isError: false, output: renderTodoList(current) };
        }

        // Write mode — replace the full list and return the new state.
        this.setTodos(args.todos);
        const stored = this.getTodos();
        const output =
          stored.length === 0 ? 'Todo list cleared.' : `Todo list updated.\n${renderTodoList(stored)}`;
        return { isError: false, output };
      },
    };
  }

  private getTodos(): readonly TodoItem[] {
    const todos = this.store.get(TODO_STORE_KEY);
    return todos ?? [];
  }

  private setTodos(todos: readonly TodoItem[]): void {
    this.store.set(
      TODO_STORE_KEY,
      todos.map((todo) => ({ title: todo.title, status: todo.status, phase: todo.phase })),
    );
  }
}

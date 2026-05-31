import { z } from 'zod';

// Mirrors scream-cli's `Metadata` pydantic model (metadata.py:43–49).
export const OldWorkDirMetaSchema = z.object({
  path: z.string(),
  jian: z.string().default('local'),
  last_session_id: z.string().nullable().optional(),
});

export const OldScreamJsonSchema = z.object({
  work_dirs: z.array(OldWorkDirMetaSchema).default([]),
});

// Mirrors scream-cli's `SessionState` (session_state.py:28–45).
// We use `.passthrough()` because old persisted state may carry extra
// fields from newer scream-cli versions; we only consume a known subset.
export const OldSessionStateSchema = z
  .object({
    version: z.number().optional(),
    approval: z
      .object({
        yolo: z.boolean().optional(),
        afk: z.boolean().optional(),
        auto_approve_actions: z.array(z.string()).optional(),
      })
      .partial()
      .optional(),
    additional_dirs: z.array(z.string()).optional(),
    custom_title: z.string().nullable().optional(),
    title_generated: z.boolean().optional(),
    title_generate_attempts: z.number().optional(),
    plan_mode: z.boolean().optional(),
    plan_session_id: z.string().nullable().optional(),
    plan_slug: z.string().nullable().optional(),
    wire_mtime: z.number().nullable().optional(),
    archived: z.boolean().optional(),
    archived_at: z.number().nullable().optional(),
    auto_archive_exempt: z.boolean().optional(),
    todos: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type OldScreamJson = z.infer<typeof OldScreamJsonSchema>;
export type OldWorkDirMeta = z.infer<typeof OldWorkDirMetaSchema>;
export type OldSessionState = z.infer<typeof OldSessionStateSchema>;

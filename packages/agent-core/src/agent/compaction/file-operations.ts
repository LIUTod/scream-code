import type { Message } from '@scream-code/ltod';

export interface FileOperations {
  readonly read: Set<string>;
  readonly written: Set<string>;
  readonly edited: Set<string>;
}

export function createFileOps(): FileOperations {
  return {
    read: new Set(),
    written: new Set(),
    edited: new Set(),
  };
}

export function extractFileOpsFromMessage(message: Message, ops: FileOperations): void {
  if (message.role !== 'assistant') return;
  for (const call of message.toolCalls) {
    if (call.type !== 'function' || call.arguments === null) continue;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.arguments) as Record<string, unknown>;
    } catch {
      continue;
    }
    const path = typeof args['path'] === 'string' ? args['path'] : undefined;
    if (path === undefined || path.length === 0) continue;
    switch (call.name) {
      case 'Read':
        ops.read.add(path);
        break;
      case 'Edit':
        ops.edited.add(path);
        break;
      case 'Write':
        ops.written.add(path);
        break;
    }
  }
}

const FILE_LIMIT = 20;

export function formatFileOperations(ops: FileOperations): string {
  const modified = new Set<string>([...ops.edited, ...ops.written]);
  const readOnly = [...ops.read].filter((f) => !modified.has(f)).sort();
  const modifiedFiles = [...modified].sort();
  const all = [...new Set([...readOnly, ...modifiedFiles])].sort();
  if (all.length === 0) return '';

  const mode = new Map<string, 'Read' | 'Write' | 'RW'>();
  for (const f of readOnly) mode.set(f, 'Read');
  for (const f of modifiedFiles) mode.set(f, ops.read.has(f) ? 'RW' : 'Write');

  const lines: string[] = ['<files>'];
  for (const f of all.slice(0, FILE_LIMIT)) {
    lines.push(`${f} (${mode.get(f)})`);
  }
  if (all.length > FILE_LIMIT) {
    lines.push(`[…${all.length - FILE_LIMIT} files elided…]`);
  }
  lines.push('</files>');
  return lines.join('\n');
}

export function upsertFileOperations(summary: string, ops: FileOperations): string {
  const base = summary.replace(/<files>[\s\S]*?<\/files>\s*/g, '').trimEnd();
  const filesSection = formatFileOperations(ops);
  return filesSection.length > 0 ? `${base}\n\n${filesSection}` : base;
}

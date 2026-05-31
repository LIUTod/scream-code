import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedMessage } from './translator.js';

export const WIRE_PROTOCOL_VERSION = '1.0';

export interface WireWriteInput {
  readonly createdAtMs: number;
  readonly messages: readonly NormalizedMessage[];
}

export async function writeMainAgentWire(sessionDir: string, input: WireWriteInput): Promise<void> {
  const wireDir = join(sessionDir, 'agents', 'main');
  await mkdir(wireDir, { recursive: true, mode: 0o700 });

  const metadata = {
    type: 'metadata',
    protocol_version: WIRE_PROTOCOL_VERSION,
    created_at: input.createdAtMs,
  };
  const lines: string[] = [JSON.stringify(metadata)];
  for (const msg of input.messages) {
    lines.push(JSON.stringify({ type: 'context.append_message', message: msg }));
  }
  await writeFile(join(wireDir, 'wire.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

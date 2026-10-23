import type { Message } from '../../../shared/contracts';

// Array metadata keeps the public BotClient array contract without leaking transport envelopes.
interface TranscriptStamp { readonly version: number; readonly generation: number; readonly reset?: boolean }
const transcriptVersions = new WeakMap<readonly Message[], TranscriptStamp>();
const epochs = new Map<string, number>();

/** Register only an accepted process epoch; HTTP orders epoch discovery before calling this. */
export function transcriptGeneration(epoch: string): number {
  let generation = epochs.get(epoch);
  if (generation === undefined) { generation = epochs.size + 1; epochs.set(epoch, generation); }
  return generation;
}

export function transcriptVersion(messages: readonly Message[] | undefined): number | undefined {
  return messages === undefined ? undefined : transcriptVersions.get(messages)?.version;
}

export function stampTranscript(messages: Message[], source: Message[]): Message[] {
  const stamp = transcriptVersions.get(source);
  if (stamp !== undefined) transcriptVersions.set(messages, stamp);
  return messages;
}

export function versionTranscript(messages: Message[], version: number, generation = 0): Message[] {
  transcriptVersions.set(messages, { version, generation });
  return messages;
}

/** Fence responses already resolved before a new SSE epoch reaches the query cache. */
export function fenceTranscript(existing: Message[] | undefined, epoch: string): Message[] | undefined {
  if (existing === undefined) return undefined;
  const generation = transcriptGeneration(epoch);
  const previous = transcriptVersions.get(existing);
  if (previous !== undefined && previous.generation >= generation) return existing;
  const messages = [...existing];
  transcriptVersions.set(messages, { version: 0, generation, reset: true });
  return messages;
}

/** Reconcile at query-cache write time, not merely when the HTTP promise resolves. */
export function reconcileTranscript(existing: Message[] | undefined, incoming: Message[]): Message[] {
  const previous = existing === undefined ? undefined : transcriptVersions.get(existing);
  const next = transcriptVersions.get(incoming);
  if (existing === undefined || previous === undefined) return incoming;
  if (next === undefined) return existing;
  if (next.generation < previous.generation) return existing;
  if (next.generation > previous.generation || previous.reset === true) return incoming;
  const stale = next.version < previous.version;
  const current = new Map(existing.map((message) => [message.id, message]));
  let retained = false;
  const merged = incoming.map((message) => {
    const live = current.get(message.id);
    if (live !== undefined && (stale || (live.projectionVersion ?? -1) > (message.projectionVersion ?? -1))) {
      retained = true;
      return live;
    }
    return message;
  });
  const included = new Set(incoming.map((message) => message.id));
  for (const message of existing) {
    if (!included.has(message.id) && (stale || (message.projectionVersion ?? -1) > next.version)) { merged.push(message); retained = true; }
  }
  if (!stale && !retained) return incoming;
  return versionTranscript(merged, stale ? previous.version : next.version, previous.generation);
}

export function upsertLiveMessage(existing: Message[] | undefined, message: Message, version?: number, epoch?: string): Message[] {
  const previous = existing === undefined ? undefined : transcriptVersions.get(existing);
  const generation = epoch === undefined ? 0 : transcriptGeneration(epoch);
  if (version === undefined && previous !== undefined) return existing ?? [];
  if (version !== undefined && previous !== undefined &&
    (generation < previous.generation || (generation === previous.generation && version < previous.version))) return existing ?? [];
  const baseline = previous !== undefined && (generation > previous.generation || previous.reset === true) ? [] : existing ?? [];
  const found = baseline.some((item) => item.id === message.id);
  const messages = found
    ? baseline.map((item) => item.id === message.id ? message : item)
    : [...baseline, message];
  return version === undefined ? messages : versionTranscript(messages, version, generation);
}

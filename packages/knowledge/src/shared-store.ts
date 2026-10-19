import { mkdirSync } from 'node:fs';
import { join } from 'pathe';

import { createEmbeddingEngine } from '@scream-code/memory';

import { KnowledgeStore } from './store.js';

interface SharedEntry {
  readonly store: KnowledgeStore;
  readonly ready: Promise<void>;
}

const entries = new Map<string, SharedEntry>();

function entryFor(homeDir: string): SharedEntry {
  const existing = entries.get(homeDir);
  if (existing !== undefined) return existing;
  const store = new KnowledgeStore(homeDir);
  const ready = (async () => {
    try {
      await store.init();
      // The directory name is a legacy path kept for cache compatibility: the
      // downloaded model payload lives there and existing installs must keep
      // finding it (see @scream-code/memory for the layout).
      const cacheDir = join(homeDir, 'cache', 'fastembed');
      mkdirSync(cacheDir, { recursive: true });
      store.setEmbeddingEngine(createEmbeddingEngine(cacheDir));
    } catch (error) {
      // Drop the entry so the next caller rebuilds — same retry-on-failure
      // contract the per-host store promises used to give each side.
      entries.delete(homeDir);
      throw error;
    }
  })();
  const entry: SharedEntry = { store, ready };
  entries.set(homeDir, entry);
  return entry;
}

/**
 * Process-level KnowledgeStore per homeDir, plus the embedding engine wired
 * onto it — one handle and one status source instead of one per host (TUI
 * command vs agent session).
 *
 * The map key is the raw homeDir string so the engine cache key
 * join(homeDir, 'cache', 'fastembed') stays byte-identical with every other
 * createEmbeddingEngine call site: same string → same engine instance.
 */
export function sharedKnowledgeStore(homeDir: string): KnowledgeStore {
  return entryFor(homeDir).store;
}

/** Resolves once init + engine wiring finished; rejects once per failed build. */
export function sharedKnowledgeStoreReady(homeDir: string): Promise<void> {
  return entryFor(homeDir).ready;
}

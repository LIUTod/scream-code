import type { Component } from '@earendil-works/pi-tui';

import type { TranscriptEntry } from '../types';

const componentEntries = new WeakMap<Component, TranscriptEntry>();

/**
 * Associates a transcript entry with a UI component so that undo and other
 * transcript-level operations can map between the two.
 */
export function markTranscriptComponent(component: Component, entry: TranscriptEntry): void {
  componentEntries.set(component, entry);
}

/**
 * Returns the transcript entry previously associated with `component`, or
 * `undefined` if no entry was marked.
 */
export function getTranscriptComponentEntry(
  component: Component,
): TranscriptEntry | undefined {
  return componentEntries.get(component);
}

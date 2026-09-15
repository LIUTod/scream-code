import type { Container } from '@liutod-scream/pi-tui';

export interface Expandable {
  setExpanded(expanded: boolean): void;
}

export interface ExpandedState {
  isExpanded(): boolean;
}

export interface PlanExpandable {
  // Returns true iff the component actually owns a plan preview and
  // applied the new state.
  setPlanExpanded(expanded: boolean): boolean;
}

export interface Disposable {
  dispose(): void;
}

export function isExpandable(obj: unknown): obj is Expandable {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'setExpanded' in obj &&
    typeof (obj as Expandable).setExpanded === 'function'
  );
}

export function isPlanExpandable(obj: unknown): obj is PlanExpandable {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'setPlanExpanded' in obj &&
    typeof (obj as PlanExpandable).setPlanExpanded === 'function'
  );
}

/**
 * Reads a component's current expansion state. Components that only accept
 * `setExpanded` (or that return something other than a boolean) yield
 * undefined, so callers fall back to their own last value instead of guessing.
 */
export function readExpanded(obj: unknown): boolean | undefined {
  if (typeof obj !== 'object' || obj === null || !('isExpanded' in obj)) return undefined;
  const reader = (obj as Partial<ExpandedState>).isExpanded;
  if (typeof reader !== 'function') return undefined;
  const value: unknown = reader.call(obj);
  // Only a real boolean counts: anything else leaves the caller on its fallback
  // path instead of flipping a component on a truthy non-boolean.
  return typeof value === 'boolean' ? value : undefined;
}

export function hasDispose(value: unknown): value is Disposable {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dispose' in value &&
    typeof (value as Disposable).dispose === 'function'
  );
}

export function disposeChildren(container: Container): void {
  for (const child of container.children) {
    if (hasDispose(child)) child.dispose();
  }
  container.clear();
}

export interface Expandable {
  setExpanded(expanded: boolean): void;
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

export function hasDispose(value: unknown): value is Disposable {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dispose' in value &&
    typeof (value as Disposable).dispose === 'function'
  );
}

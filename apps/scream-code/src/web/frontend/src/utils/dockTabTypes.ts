import type { IconName } from '../components/ui/SvgIcon.vue';

/**
 * Dock tab registry — every tab kind the right column can host.
 *
 * `file` is the multi-instance kind (one tab per opened path); all other
 * kinds are session-level and singleton: re-opening an already-open kind
 * activates the existing tab instead of creating a new one.
 */

export type SessionDockKind = 'detail' | 'control' | 'agents' | 'run' | 'git' | 'todo' | 'goal' | 'like';
export type DockTabKind = 'file' | SessionDockKind;

export interface DockTabType {
  kind: DockTabKind;
  /** Label shown on the tab strip. */
  label: string;
  icon: IconName;
  /** Session-level kinds keep at most one open tab at a time. */
  singleton: boolean;
}

const registry = new Map<DockTabKind, DockTabType>();

/** Register (or override) a dock tab type. Kinds must be declared here
 *  before anything can open a tab of that kind. */
export function registerDockTabType(type: DockTabType): DockTabType {
  registry.set(type.kind, type);
  return type;
}

export function dockTabType(kind: DockTabKind): DockTabType {
  const type = registry.get(kind);
  if (!type) throw new Error(`unregistered dock tab kind: ${kind}`);
  return type;
}

export function isRegisteredDockTabKind(kind: unknown): kind is DockTabKind {
  return typeof kind === 'string' && registry.has(kind as DockTabKind);
}

registerDockTabType({ kind: 'file', label: '文件', icon: 'file', singleton: false });
registerDockTabType({ kind: 'detail', label: '会话详情', icon: 'layers', singleton: true });
registerDockTabType({ kind: 'control', label: '会话控制', icon: 'wrench', singleton: true });
registerDockTabType({ kind: 'agents', label: '协作代理', icon: 'bot', singleton: true });
registerDockTabType({ kind: 'run', label: '运行状态', icon: 'activity', singleton: true });
registerDockTabType({ kind: 'git', label: 'Git', icon: 'git-branch', singleton: true });
registerDockTabType({ kind: 'todo', label: 'Todo', icon: 'clipboard', singleton: true });
registerDockTabType({ kind: 'goal', label: '目标', icon: 'target', singleton: true });
registerDockTabType({ kind: 'like', label: '偏好', icon: 'user', singleton: true });

/** Stable id for a session-level dock tab — one per kind, per design. */
export function sessionDockTabId(kind: SessionDockKind): string {
  return `dock:${kind}`;
}

/** Stable DOM ids used to connect a tab to its tabpanel for assistive tech. */
export function dockTabDomId(tabId: string): string {
  return `dock-tab-${encodeURIComponent(tabId)}`;
}

export function dockPanelDomId(tabId: string): string {
  return `dock-panel-${encodeURIComponent(tabId)}`;
}

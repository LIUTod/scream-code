import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  type SidebarData,
  type SidebarPanel,
} from './sidebar-panel';

/**
 * Optional persistence for the sidebar width. The host wires a config-backed
 * store here (matching a web-sidebar width-persistence pattern); when
 * omitted the width is in-memory for the session only.
 */
export interface SidebarWidthStore {
  load(): number;
  save(cols: number): void;
}

/**
 * Owns which sidebar panels are registered, which one is active, whether the
 * sidebar is open, and its width. Rendering is delegated back to the host via
 * the injected `requestRender`; the manager itself holds no Component state.
 */
export class SidebarManager {
  private readonly panels: SidebarPanel[] = [];
  private readonly byId = new Map<string, SidebarPanel>();
  private activeId: string | null = null;
  private open = false;
  private width = SIDEBAR_DEFAULT_WIDTH;
  private readonly widthStore: SidebarWidthStore | undefined;
  private dataProvider: (() => SidebarData) | undefined;
  private readonly requestRender: () => void;

  constructor(
    requestRender: () => void,
    opts?: { widthStore?: SidebarWidthStore; dataProvider?: () => SidebarData },
  ) {
    this.requestRender = requestRender;
    this.widthStore = opts?.widthStore;
    this.dataProvider = opts?.dataProvider;
    if (opts?.widthStore !== undefined) {
      this.width = clampSidebarWidth(opts.widthStore.load());
    }
  }

  getData(): SidebarData {
    return this.dataProvider?.() ?? {};
  }

  setDataProvider(provider: () => SidebarData): void {
    this.dataProvider = provider;
  }

  register(panel: SidebarPanel): void {
    if (this.byId.has(panel.id)) return;
    this.panels.push(panel);
    this.byId.set(panel.id, panel);
  }

  unregister(id: string): void {
    const idx = this.panels.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const [panel] = this.panels.splice(idx, 1);
    this.byId.delete(id);
    if (this.activeId === id) {
      this.activeId = null;
      this.open = false;
      panel?.onClose?.();
    }
    this.requestRender();
  }

  get isOpen(): boolean {
    return this.open;
  }

  get hasPanels(): boolean {
    return this.panels.length > 0;
  }

  get activePanel(): SidebarPanel | undefined {
    return this.activeId === null ? undefined : this.byId.get(this.activeId);
  }

  get currentWidth(): number {
    return this.width;
  }

  get allPanels(): readonly SidebarPanel[] {
    return this.panels;
  }

  /**
   * Panels that should render in the current stacked sidebar, in registration
   * order, filtered by each panel's `visible(data)` predicate (panels without
   * one are always visible).
   */
  getStackPanels(): readonly SidebarPanel[] {
    const data = this.getData();
    return this.panels.filter((panel) => panel.visible?.(data) ?? true);
  }

  /** True when `panel` would currently render in the stack. */
  isStacked(panel: SidebarPanel): boolean {
    const data = this.getData();
    return panel.visible?.(data) ?? true;
  }

  activate(id: string): boolean {
    const panel = this.byId.get(id);
    if (panel === undefined) return false;
    if (this.open && this.activeId === id) return true;
    const previous = this.activeId === null ? undefined : this.byId.get(this.activeId);
    previous?.onClose?.();
    this.activeId = id;
    this.open = true;
    panel.onOpen?.();
    this.requestRender();
    return true;
  }

  toggle(id?: string): void {
    // No argument and nothing active: open the first visible stack panel so a
    // bare `/sidebar` actually reveals the sidebar instead of no-oping.
    if (id === undefined && this.activeId === null) {
      const [first] = this.getStackPanels();
      if (first === undefined) return;
      this.activate(first.id);
      return;
    }
    const target = id ?? this.activeId;
    if (target === null || !this.byId.has(target)) return;
    if (this.open && this.activeId === target) {
      this.close();
      return;
    }
    this.activate(target);
  }

  close(): void {
    if (!this.open) return;
    const panel = this.activePanel;
    this.open = false;
    this.activeId = null;
    panel?.onClose?.();
    this.requestRender();
  }

  next(): void {
    this.step(1);
  }

  prev(): void {
    this.step(-1);
  }

  private step(dir: 1 | -1): void {
    const stack = this.getStackPanels();
    if (stack.length === 0) return;
    const idx = this.activeId === null ? -1 : stack.findIndex((p) => p.id === this.activeId);
    // Focus only walks the visible stack so next/prev never lands on a
    // hidden section (e.g. Goal while no goal is active).
    const nextIdx =
      idx === -1
        ? dir === 1
          ? 0
          : stack.length - 1
        : (idx + dir + stack.length) % stack.length;
    this.activate(stack[nextIdx]!.id);
  }

  setWidth(cols: number): void {
    this.width = clampSidebarWidth(cols);
    this.widthStore?.save(this.width);
    this.requestRender();
  }

  resetWidth(): void {
    this.width = SIDEBAR_DEFAULT_WIDTH;
    this.widthStore?.save(this.width);
    this.requestRender();
  }
}

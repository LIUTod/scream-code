import { clampSidebarWidth, sidebarWidthFor, type SidebarData } from './session-status';

/**
 * Whether the session-status sidebar is open, how wide it is, and where its
 * data comes from. Rendering is delegated back to the host through the
 * injected `requestRender`; the manager holds no Component state.
 *
 * The width follows the terminal (see {@link sidebarWidthFor}) until the person
 * sets one with `/sidebar width`; `/sidebar width reset` hands it back.
 */
export class SidebarManager {
  private open = false;
  private manualWidth: number | undefined;
  private dataProvider: (() => SidebarData) | undefined;

  constructor(
    private readonly requestRender: () => void,
    options?: { dataProvider?: () => SidebarData },
  ) {
    this.dataProvider = options?.dataProvider;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** The width the person chose, or undefined while it follows the terminal. */
  get chosenWidth(): number | undefined {
    return this.manualWidth;
  }

  /** The column count the sidebar takes on a terminal `cols` wide. */
  widthFor(cols: number): number {
    return this.manualWidth ?? sidebarWidthFor(cols);
  }

  getData(): SidebarData {
    return this.dataProvider?.() ?? {};
  }

  setDataProvider(provider: () => SidebarData): void {
    this.dataProvider = provider;
  }

  toggle(): void {
    this.open = !this.open;
    this.requestRender();
  }

  setWidth(cols: number): void {
    this.manualWidth = clampSidebarWidth(cols);
    this.requestRender();
  }

  resetWidth(): void {
    this.manualWidth = undefined;
    this.requestRender();
  }
}

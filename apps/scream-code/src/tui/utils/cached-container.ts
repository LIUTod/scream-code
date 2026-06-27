import { Container, type Component } from '@earendil-works/pi-tui';

/**
 * A Container that caches its rendered lines until explicitly invalidated or
 * its child list changes.
 *
 * pi-tui's built-in `Container.render()` walks and concatenates every child on
 * every frame. For large static subtrees (e.g., committed transcript history)
 * this work is wasted because the children do not change between frames.
 *
 * This subclass caches the concatenated output. Callers are responsible for
 * invalidating the container when a child mutates internally; structural
 * changes (`addChild`, `removeChild`, `clear`) automatically mark the cache
 * dirty.
 */
export class CachedContainer extends Container {
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private dirty = true;

  override addChild(component: Component): void {
    super.addChild(component);
    this.markDirty();
  }

  override removeChild(component: Component): void {
    // oxlint-disable-next-line unicorn/prefer-dom-node-remove -- pi-tui Container API, not DOM.
    super.removeChild(component);
    this.markDirty();
  }

  override clear(): void {
    super.clear();
    this.markDirty();
  }

  override invalidate(): void {
    super.invalidate();
    this.markDirty();
  }

  override render(width: number): string[] {
    if (!this.dirty && this.cachedWidth === width && this.cachedLines !== undefined) {
      return this.cachedLines;
    }

    this.cachedWidth = width;
    this.cachedLines = super.render(width);
    this.dirty = false;
    return this.cachedLines;
  }

  protected markDirty(): void {
    this.dirty = true;
  }
}

/**
 * Session teardown registry.
 *
 * `Session.close()` used to run its cleanups as a hand-maintained inline
 * sequence. Every new resource had to be remembered and spliced into that
 * sequence by hand, and omissions (the shell tool's pending-task map, the
 * message bus, ...) stayed invisible until they leaked. This registry makes
 * the close-out list explicit and inspectable: each step registers once at
 * session construction under a stable name, `names()` exposes the checklist
 * (tests freeze it so a dropped or renamed registration fails immediately),
 * and `disposeAll()` releases the steps in reverse registration order — last
 * registered, first released — without letting one failure skip the rest.
 */

export class SessionDisposables {
  private readonly items: Array<{ name: string; fn: () => void | Promise<void> }> = [];
  private disposed = false;

  /**
   * Register a teardown step under a unique name.
   *
   * Duplicate names are rejected rather than silently overwriting: two owners
   * for one checklist slot is a registration bug, and an overwrite would hide
   * it. Registration after `disposeAll()` is rejected for the same reason —
   * the step could never run, which is exactly the silent-omission failure
   * this registry exists to prevent.
   */
  add(name: string, fn: () => void | Promise<void>): void {
    if (this.disposed) {
      throw new Error(`Cannot register disposable "${name}" after disposeAll() has run`);
    }
    if (this.items.some((item) => item.name === name)) {
      throw new Error(`Disposable "${name}" is already registered`);
    }
    this.items.push({ name, fn });
  }

  /** Registered names in registration order — the close-out checklist. */
  names(): readonly string[] {
    return this.items.map((item) => item.name);
  }

  /**
   * Run every registered step in reverse registration order. A throwing step
   * never blocks the steps after it; every failure is collected and returned
   * as one `AggregateError` (`null` when all steps succeeded). Idempotent:
   * once disposed, further calls run nothing and report no errors.
   */
  async disposeAll(): Promise<AggregateError | null> {
    if (this.disposed) return null;
    this.disposed = true;
    const errors: unknown[] = [];
    for (const item of this.items.toReversed()) {
      try {
        await item.fn();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors.length === 0
      ? null
      : new AggregateError(errors, `${String(errors.length)} session disposal step(s) failed`);
  }
}

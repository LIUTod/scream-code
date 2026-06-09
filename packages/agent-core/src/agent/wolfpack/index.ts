import type { Agent } from '..';

export class WolfPackMode {
  private _isActive = false;

  constructor(private readonly agent: Agent) {}

  enter(): void {
    if (this._isActive) return;
    this._isActive = true;
    this.agent.records.logRecord({ type: 'wolfpack.enter' });
    this.agent.emitStatusUpdated();
  }

  restoreEnter(): void {
    this._isActive = true;
  }

  exit(): void {
    if (!this._isActive) return;
    this.agent.records.logRecord({ type: 'wolfpack.exit' });
    this._isActive = false;
    this.agent.emitStatusUpdated();
  }

  get isActive(): boolean {
    return this._isActive;
  }
}

import type { Agent } from '..';
import type { AgentReplayRecord } from '../..';

export class ReplayBuilder {
  protected readonly records: AgentReplayRecord[] = [];

  constructor(public readonly agent: Agent) {}

  push(record: AgentReplayRecord): void {
    if (this.agent.records.restoring) {
      this.records.push(record);
    }
  }

  buildResult(): readonly AgentReplayRecord[] {
    return this.records;
  }
}

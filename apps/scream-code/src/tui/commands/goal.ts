import type { SlashCommandHost } from './dispatch';

// ── Parsing ─────────────────────────────────────────────────────────────

const CONTROL_SUBCOMMANDS = new Set(['pause', 'resume']);

export type ParsedGoalCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'create'; readonly objective: string; readonly replace: boolean }
  | { readonly kind: 'error'; readonly message: string; readonly severity?: 'error' | 'hint' };

/**
 * Parse the `/goal` command.
 *
 * Reserved subcommands (`pause`/`resume`/`status`/`replace`) are honored
 * as the first token.  Use `/goal -- <objective>` to start a goal whose
 * text begins with a reserved word.  Use `/goaloff` to cancel.
 */
export function parseGoalCommand(rawArgs: string): ParsedGoalCommand {
  const args = rawArgs.trim();
  if (args.length === 0 || args === 'status') return { kind: 'status' };

  const tokens = args.split(/\s+/);
  const first = tokens[0];
  if (first !== undefined && CONTROL_SUBCOMMANDS.has(first) && tokens.length === 1) {
    return { kind: first as 'pause' | 'resume' };
  }

  let index = 0;
  let replace = false;
  if (tokens[index] === 'replace') {
    replace = true;
    index += 1;
  }
  // `--` ends subcommand parsing so an objective can begin with a reserved word
  if (tokens[index] === '--') {
    index += 1;
  }

  const objective = tokens.slice(index).join(' ').trim();
  if (objective.length === 0) {
    return {
      kind: 'error',
      severity: 'hint',
      message: '请提供目标描述，例如 `/goal 实现登录功能`。',
    };
  }
  return { kind: 'create', objective, replace };
}

// ── Command handler ─────────────────────────────────────────────────────

export async function handleGoalCommand(host: SlashCommandHost, args: string): Promise<void> {
  const parsed = parseGoalCommand(args);
  switch (parsed.kind) {
    case 'error':
      if (parsed.severity === 'hint') host.showStatus(parsed.message);
      else host.showError(parsed.message);
      return;
    case 'status':
      showGoalStatus(host);
      return;
    case 'pause':
      pauseGoal(host);
      return;
    case 'resume':
      resumeGoal(host);
      return;
    case 'create':
      createGoal(host, parsed);
      return;
  }
}

// ── Subcommand implementations ──────────────────────────────────────────

function createGoal(host: SlashCommandHost, parsed: ParsedGoalCommand & { kind: 'create' }): void {
  host.setAppState({
    goal: parsed.objective,
    goalActive: true,
    goalContinuationCount: 0,
  });
  syncGoalMetadata(host);
  host.showStatus(`🎯 目标已设置：${parsed.objective}`);

  // Auto-start: send the objective as user input to begin execution
  const session = host.session;
  if (session !== undefined && host.state.appState.streamingPhase === 'idle') {
    host.sendQueuedMessage(session, { text: parsed.objective, agentId: undefined });
  } else if (session !== undefined) {
    host.state.queuedMessages.push({ text: parsed.objective, agentId: undefined });
  }
}

function pauseGoal(host: SlashCommandHost): void {
  if (!host.state.appState.goalActive) {
    host.showStatus('🎯 没有可暂停的目标。');
    return;
  }
  if (host.state.appState.goalActive && host.state.appState.goal === null) {
    host.showStatus('🎯 当前没有激活的目标。');
    return;
  }
  host.setAppState({ goalActive: false });
  syncGoalMetadata(host);
  host.showStatus('🎯 目标已暂停。使用 `/goal resume` 恢复。');
}

function resumeGoal(host: SlashCommandHost): void {
  if (host.state.appState.goalActive) {
    host.showStatus('🎯 目标已在运行中。');
    return;
  }
  const goal = host.state.appState.goal;
  if (goal === null) {
    host.showStatus('🎯 没有可恢复的目标。使用 `/goal <指令>` 设置新目标。');
    return;
  }
  host.setAppState({ goalActive: true, goalContinuationCount: 0 });
  syncGoalMetadata(host);
  host.showStatus('🎯 目标已恢复。');
  // Resume execution
  const session = host.session;
  if (session !== undefined && host.state.appState.streamingPhase === 'idle') {
    host.sendQueuedMessage(session, { text: '继续执行当前目标。', agentId: undefined });
  }
}

export async function handleGoalOffCommand(host: SlashCommandHost): Promise<void> {
  const hadGoal = host.state.appState.goalActive || host.state.appState.goal !== null;
  host.setAppState({
    goal: null,
    goalActive: false,
    goalContinuationCount: 0,
  });
  syncGoalMetadata(host);
  if (hadGoal) {
    host.showStatus('🎯 目标已取消。');
  } else {
    host.showStatus('🎯 当前没有激活的目标。');
  }
}

function showGoalStatus(host: SlashCommandHost): void {
  const { goal, goalActive, goalContinuationCount } = host.state.appState;
  if (goal === null) {
    host.showStatus('🎯 当前没有设置目标。使用 `/goal <指令>` 设置新目标。');
    return;
  }
  const statusTag = goalActive ? '▶ 运行中' : '⏸ 已暂停';
  const parts = [
    `🎯 ${statusTag}`,
    `   目标：${goal}`,
    `   已自动继续 ${goalContinuationCount} 次`,
  ];
  if (!goalActive) {
    parts.push('   使用 `/goal resume` 恢复，或 `/goaloff` 取消');
  } else {
    parts.push('   使用 `/goal pause` 暂停，或 `/goaloff` 取消');
  }
  host.showStatus(parts.join('\n'), host.state.theme.colors.success);
}

// ── Metadata sync ───────────────────────────────────────────────────────

function syncGoalMetadata(host: SlashCommandHost): void {
  const session = host.session;
  if (session === undefined) return;
  const { appState } = host.state;
  if (!session.metadata['custom']) {
    session.metadata['custom'] = {};
  }
  (session.metadata['custom'] as Record<string, unknown>)['goal'] = {
    active: appState.goalActive,
    content: appState.goal,
    continuationCount: appState.goalContinuationCount,
  };
  void session.writeMetadata();
}

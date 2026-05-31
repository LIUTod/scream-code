import type { SlashCommandHost } from './dispatch';

interface GoalMeta {
  active: boolean;
  content: string | null;
  continuationCount: number;
}

function syncGoalMetadata(host: SlashCommandHost): void {
  const session = host.session;
  if (session === undefined) return;
  const { appState } = host.state;
  if (!session.metadata.custom) {
    session.metadata.custom = {};
  }
  session.metadata.custom.goal = {
    active: appState.goalActive,
    content: appState.goal,
    continuationCount: appState.goalContinuationCount,
  };
  void session.writeMetadata();
}

export async function handleGoalCommand(host: SlashCommandHost, args: string): Promise<void> {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    // 显示当前 goal 状态
    showGoalStatus(host);
    return;
  }

  // 设置新 goal
  host.setAppState({
    goal: trimmed,
    goalActive: true,
    goalContinuationCount: 0,
  });
  syncGoalMetadata(host);
  host.showStatus(`🎯 目标已设置：${trimmed}`);

  // 自动开始执行目标
  const session = host.session;
  if (session !== undefined && host.state.appState.streamingPhase === 'idle') {
    host.sendQueuedMessage(session, { text: trimmed, agentId: undefined });
  } else if (session !== undefined) {
    host.state.queuedMessages.push({ text: trimmed, agentId: undefined });
  }
}

export async function handleGoalOffCommand(host: SlashCommandHost): Promise<void> {
  const hadGoal = host.state.appState.goalActive;
  host.setAppState({
    goal: null,
    goalActive: false,
    goalContinuationCount: 0,
  });
  syncGoalMetadata(host);
  if (hadGoal) {
    host.showStatus('🎯 目标模式已关闭');
  } else {
    host.showStatus('🎯 当前没有激活的目标');
  }
}

function showGoalStatus(host: SlashCommandHost): void {
  const { goal, goalActive, goalContinuationCount } = host.state.appState;
  if (!goalActive || goal === null) {
    host.showStatus('🎯 当前没有激活的目标。输入 /goal <指令> 设置目标。');
    return;
  }
  host.showStatus(
    `🎯 目标状态：已激活 | 内容：${goal} | 已自动继续 ${goalContinuationCount} 次`,
    'green',
  );
}

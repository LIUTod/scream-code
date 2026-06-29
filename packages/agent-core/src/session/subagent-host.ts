import type { TokenUsage } from '@scream-code/ltod';

import type { Agent } from '../agent';
import type { PromptOrigin } from '../agent/context';
import type { LoopTurnStopReason } from '../loop';
import {
  DEFAULT_AGENT_PROFILES,
  prepareSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import { linkAbortSignal, userCancellationReason } from '../utils/abort';
import { collectGitContext } from './git-context';
import type { Session } from './index';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md';
import { getFindingsFromStore } from '../tools/builtin/collaboration/report-finding';

/**
 * A subagent summary shorter than this many characters triggers one
 * follow-up turn that asks the subagent to expand it, so the parent
 * agent receives a technically complete handoff.
 */
const SUMMARY_MIN_LENGTH = 200;
const SUMMARY_CONTINUATION_ATTEMPTS = 1;
const HOOK_TEXT_PREVIEW_LENGTH = 500;
const SUBAGENT_MAX_TOKENS_ERROR =
  'Subagent turn failed before completing its final summary: reason=max_tokens';

type RunSubagentOptions = {
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string | undefined;
  readonly prompt: string;
  readonly description: string;
  readonly runInBackground: boolean;
  readonly origin?: PromptOrigin | undefined;
  readonly signal: AbortSignal;
};

type SubagentCompletion = {
  readonly result: string;
  readonly usage?: TokenUsage;
};

type ActiveChild = {
  readonly controller: AbortController;
  readonly runInBackground: boolean;
};

export type SubagentHandle = {
  readonly agentId: string;
  readonly profileName: string;
  readonly resumed: boolean;
  readonly completion: Promise<SubagentCompletion>;
};

export class SessionSubagentHost {
  private readonly activeChildren = new Map<string, ActiveChild>();

  constructor(
    private readonly session: Session,
    private readonly ownerAgentId: string,
    readonly backgroundTaskTimeoutMs?: number | undefined,
    private readonly modelBindings?: () => Record<string, string | undefined>,
  ) {}

  async spawn(profileName: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();

    const parent = this.session.agents.get(this.ownerAgentId);
    if (parent === undefined) {
      throw new Error(`Parent agent "${this.ownerAgentId}" was not found`);
    }

    const profile = this.resolveProfile(parent, profileName);
    const { id, agent } = await this.session.createAgent(
      { type: 'sub', generate: parent.rawGenerate },
      undefined,
      this.ownerAgentId,
    );
    const controller = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(options.signal, controller);
    this.activeChildren.set(id, {
      controller,
      runInBackground: options.runInBackground,
    });

    const completion = this.runChild(
      parent,
      id,
      agent,
      profile.name,
      {
        ...options,
        signal: controller.signal,
      },
      () => this.configureChild(parent, agent, profile),
    ).finally(() => {
      unlinkAbortSignal();
      this.activeChildren.delete(id);
    });

    return {
      agentId: id,
      profileName: profile.name,
      resumed: false,
      completion,
    };
  }

  async resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();

    const parent = this.session.agents.get(this.ownerAgentId);
    if (parent === undefined) {
      throw new Error(`Parent agent "${this.ownerAgentId}" was not found`);
    }

    const child = this.session.agents.get(agentId);
    if (child === undefined) {
      throw new Error(`Agent instance "${agentId}" was not found`);
    }
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub') {
      throw new Error(`Agent instance "${agentId}" is not a subagent`);
    }
    if (metadata.parentAgentId !== this.ownerAgentId) {
      throw new Error(`Agent instance "${agentId}" does not belong to this parent agent`);
    }
    if (this.activeChildren.has(agentId) || child.turn.hasActiveTurn) {
      throw new Error(
        `Agent instance "${agentId}" is already running and cannot be resumed concurrently`,
      );
    }

    const profileName = child.config.profileName ?? 'subagent';

    const controller = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(options.signal, controller);
    this.activeChildren.set(agentId, {
      controller,
      runInBackground: options.runInBackground,
    });

    const completion = this.runChild(
      parent,
      agentId,
      child,
      profileName,
      {
        ...options,
        signal: controller.signal,
      },
      // A resumed subagent is realigned to its bound model (or the parent's
      // current model when unbound), so a /model diy rebind or a parent
      // setModel between the initial spawn and the resume is reflected.
      () => {
        const binding = this.resolveModelBinding(profileName);
        const modelAlias = binding ?? parent.config.modelAlias;
        const thinkingLevel = this.resolveThinkingLevel(parent, binding, parent.config.thinkingLevel);
        child.config.update({ modelAlias, thinkingLevel });
        return Promise.resolve();
      },
    ).finally(() => {
      unlinkAbortSignal();
      this.activeChildren.delete(agentId);
    });

    return {
      agentId,
      profileName,
      resumed: true,
      completion,
    };
  }

  cancelAll(reason: unknown = userCancellationReason()): void {
    const foregroundChildren = Array.from(this.activeChildren).filter(
      ([, child]) => !child.runInBackground,
    );
    for (const [childId, child] of foregroundChildren) {
      this.session.agents.get(childId)?.subagentHost?.cancelAll(reason);
      // Abort with the cancel reason (a user interruption by default) so the
      // subagent's in-flight tools report the cause accurately to the model.
      child.controller.abort(reason);
    }
  }

  getProfileName(agentId: string): string | undefined {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId !== this.ownerAgentId) {
      return undefined;
    }
    return this.session.agents.get(agentId)?.config.profileName;
  }

  private resolveProfile(parent: Agent, profileName: string): ResolvedAgentProfile {
    const profile =
      DEFAULT_AGENT_PROFILES[parent.config.profileName ?? 'agent']?.subagents?.[profileName] ??
      DEFAULT_AGENT_PROFILES['agent']?.subagents?.[profileName];
    if (profile === undefined) {
      throw new Error(`Subagent profile "${profileName}" was not found`);
    }
    return profile;
  }

  private async runChild(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
    prepareChild: () => Promise<void>,
  ): Promise<SubagentCompletion> {
    parent.emitEvent({
      type: 'subagent.spawned',
      subagentId: childId,
      subagentName: profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      parentAgentId: this.ownerAgentId,
      description: options.description,
      runInBackground: options.runInBackground,
    });

    try {
      await prepareChild();
      options.signal.throwIfAborted();
      await this.triggerSubagentStart(parent, profileName, options.prompt, options.signal);
      options.signal.throwIfAborted();
      parent.emitEvent({
        type: 'subagent.started',
        subagentId: childId,
        parentToolCallId: options.parentToolCallId,
        subagentName: profileName,
        runInBackground: options.runInBackground,
      });

      // Explore subagents start cold; a git-context block helps them orient
      // in the repository before searching.
      let childPrompt = options.prompt;
      if (profileName === 'explore') {
        const gitContext = await collectGitContext(child.jian, child.config.cwd);
        if (gitContext) childPrompt = `${gitContext}\n\n${childPrompt}`;
      }
      const origin: PromptOrigin = options.origin ?? { kind: 'system_trigger', name: 'subagent' };
      child.turn.prompt([{ type: 'text', text: childPrompt }], origin);
      await runChildTurnToCompletion(child, options.signal);

      // A subagent that returns an overly terse summary leaves the parent
      // agent under-informed. Give it a bounded number of chances to expand
      // the handoff; if it is still short after that, accept it as-is rather
      // than retrying indefinitely.
      let result = lastAssistantText(child);
      let remainingContinuations = SUMMARY_CONTINUATION_ATTEMPTS;
      while (remainingContinuations > 0 && result.length < SUMMARY_MIN_LENGTH) {
        remainingContinuations -= 1;
        options.signal.throwIfAborted();
        child.turn.prompt([{ type: 'text', text: SUMMARY_CONTINUATION_PROMPT }], origin);
        await runChildTurnToCompletion(child, options.signal);
        result = lastAssistantText(child);
      }

      const usage = child.usage.data().total;

      // Aggregate structured findings produced by reviewer subagents so the
      // parent agent can act on them without re-parsing free-text summaries.
      let findingsBlock = '';
      if (profileName === 'reviewer') {
        const findings = getFindingsFromStore(child.tools.toolStore);
        if (findings.length > 0) {
          const lines = findings.map(
            (f) =>
              `- [${f.priority}] ${f.title} (${f.file_path}:${f.line_start}${
                f.line_end === f.line_start ? '' : `-${f.line_end}`
              }) confidence=${(f.confidence * 100).toFixed(0)}%`,
          );
          findingsBlock = `\n\n[review_findings]\n${lines.join('\n')}`;
        }
      }

      parent.emitEvent({
        type: 'subagent.completed',
        subagentId: childId,
        parentToolCallId: options.parentToolCallId,
        resultSummary: result,
        usage,
        contextTokens: child.context.tokenCount,
      });
      this.triggerSubagentStop(parent, profileName, result);
      return { result: result + findingsBlock, usage };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      parent.emitEvent({
        type: 'subagent.failed',
        subagentId: childId,
        parentToolCallId: options.parentToolCallId,
        error: message,
        usage: child.usage.data().total,
      });
      throw error;
    }
  }

  private async configureChild(
    parent: Agent,
    child: Agent,
    profile: ResolvedAgentProfile,
  ): Promise<void> {
    // A subagent uses the model bound to its profile via /model diy when one
    // is configured; otherwise it inherits the parent agent's model.
    const binding = this.resolveModelBinding(profile.name);
    const modelAlias = binding ?? parent.config.modelAlias;
    const thinkingLevel = this.resolveThinkingLevel(parent, binding, parent.config.thinkingLevel);
    child.config.update({
      cwd: parent.config.cwd,
      modelAlias,
      thinkingLevel,
    });

    const context = await prepareSystemPromptContext(child.jian);
    child.useProfile(profile, context);
  }

  private resolveModelBinding(profileName: string): string | undefined {
    const bindings = this.modelBindings?.();
    if (bindings === undefined) return undefined;
    const alias = bindings[profileName];
    if (typeof alias !== 'string' || alias.trim().length === 0) return undefined;
    return alias;
  }

  /**
   * When a profile binds to a different model, the parent's thinkingLevel may
   * not be supported (e.g. Claude parent with `thinking=high` spawning a GPT
   * subagent). Probe the bound model's capability and force `off` when it
   * lacks thinking support. Falls back to the parent level when the probe
   * fails (unconfigured model, no provider) so spawn still succeeds.
   */
  private resolveThinkingLevel(
    parent: Agent,
    binding: string | undefined,
    parentLevel: string,
  ): string {
    if (binding === undefined || parent.modelProvider === undefined) return parentLevel;
    try {
      const capabilities = parent.modelProvider.resolveProviderConfig(binding).modelCapabilities;
      return capabilities.thinking ? parentLevel : 'off';
    } catch {
      return parentLevel;
    }
  }

  private async triggerSubagentStart(
    parent: Agent,
    profileName: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<void> {
    await parent.hooks?.trigger('SubagentStart', {
      matcherValue: profileName,
      signal,
      inputData: {
        agentName: profileName,
        prompt: prompt.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
  }

  private triggerSubagentStop(parent: Agent, profileName: string, result: string): void {
    void parent.hooks?.fireAndForgetTrigger('SubagentStop', {
      matcherValue: profileName,
      inputData: {
        agentName: profileName,
        response: result.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
  }
}

async function runChildTurnToCompletion(child: Agent, signal: AbortSignal): Promise<void> {
  const completion = await child.turn.waitForCurrentTurn(signal);
  const turnEnded = completion.event;
  if (turnEnded.reason !== 'completed') {
    throw new Error(
      turnEnded.error === undefined
        ? `Subagent turn ${turnEnded.reason}`
        : `[${turnEnded.error.code}] ${turnEnded.error.message}`,
    );
  }
  throwIfSubagentStoppedAtMaxTokens(completion.stopReason);
}

function throwIfSubagentStoppedAtMaxTokens(stopReason: LoopTurnStopReason | undefined): void {
  if (stopReason === 'max_tokens') {
    throw new Error(`${SUBAGENT_MAX_TOKENS_ERROR}.`);
  }
}

function lastAssistantText(agent: Agent): string {
  for (const message of [...agent.context.history].toReversed()) {
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    if (text.trim().length > 0) return text.trim();
  }
  return '';
}

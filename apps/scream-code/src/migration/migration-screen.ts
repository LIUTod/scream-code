/**
 * MigrationScreenComponent — native pi-tui first-launch migration experience.
 *
 * A single mounted Container & Focusable that runs a 3-phase state machine:
 *   ask (2-step choice wizard) -> progress -> result
 *
 * Pure decision mapping (choices -> MigrationScope) is delegated to the
 * package's `resolveMigrationScope`. Rendering follows the `ChoicePicker`
 * conventions in `apps/scream-code/src/tui/components/dialogs/choice-picker.ts`.
 *
 * This file implements the ask, progress, and result phases. `beginMigration`
 * drives the real runMigration flow (injectable for tests).
 */
import { Container, matchesKey, Key, truncateToWidth, type Focusable } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import {
  resolveMigrationScope,
  runMigration as realRunMigration,
  type AnyChoice,
  type MigrationPlan,
  type MigrationPromptResult,
  type MigrationReport,
  type MigrationScope,
  type Prompt1Choice,
  type Prompt2Choice,
  type RunMigrationInput,
} from '@scream-cli/migration-legacy';

type Phase = 'ask1' | 'ask2' | 'progress' | 'result';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Spinner frame cadence — one full braille cycle every ~800ms. */
const SPINNER_INTERVAL_MS = 80;

const STEP_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['config', '配置'],
  ['mcp', 'MCP'],
  ['user-history', 'REPL 历史'],
  ['sessions', '会话'],
];

export interface MigrationScreenOptions {
  readonly plan: MigrationPlan;
  readonly sourceHome: string;
  readonly targetHome: string;
  readonly colors: ColorPalette;
  /** Called once the screen is finished; the host then restores the editor. */
  readonly onComplete: (result: MigrationScreenResult) => void;
  /** Triggers a re-render; the host wires this to `ui.requestRender()`. */
  readonly requestRender?: () => void;
  /** Injectable for tests; defaults to the package's runMigration. */
  readonly runMigration?: (input: RunMigrationInput) => Promise<MigrationReport>;
  /**
   * When true, the screen starts at the scope question and skips the
   * now/later/never gate — used by the explicit `scream migrate` command, where
   * invoking the command is itself the decision to migrate.
   */
  readonly skipDecisionStep?: boolean;
}

/** What the screen reports back to the host when finished. */
export interface MigrationScreenResult {
  readonly decision: 'now' | 'later' | 'never';
  /** Resolved migration scope; present only when decision === 'now'. */
  readonly scope?: MigrationScope;
  // present only when decision === 'now' and migration ran
  readonly migrated?: boolean;
}

interface StepDef {
  readonly title: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly value: AnyChoice }>;
}

export class MigrationScreenComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: MigrationScreenOptions;
  private phase: Phase = 'ask1';
  private selectedIndex = 0;
  private readonly choices: AnyChoice[] = [];
  private progressDone = 0;
  private progressTotal = 0;
  private readonly stepStatus = new Map<string, 'pending' | 'done'>([
    ['config', 'pending'],
    ['mcp', 'pending'],
    ['user-history', 'pending'],
    ['sessions', 'pending'],
  ]);
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private report: MigrationReport | undefined;
  private migrationFailed = false;

  constructor(opts: MigrationScreenOptions) {
    super();
    this.opts = opts;
    if (opts.skipDecisionStep === true) {
      // Explicit `scream migrate`: the now/later/never gate is meaningless, so
      // start at the scope question with the decision already fixed to 'now'.
      this.phase = 'ask2';
      this.choices.push('now');
    }
  }

  /** Host calls this once runMigration resolves. */
  showResult(report: MigrationReport): void {
    this.report = report;
    this.phase = 'result';
    this.stopSpinner();
  }

  /** Host calls this if runMigration threw. */
  showFailure(): void {
    this.migrationFailed = true;
    this.phase = 'result';
    this.stopSpinner();
  }

  /** Host calls this when migration starts. */
  enterProgress(): void {
    this.phase = 'progress';
  }

  /** Host wires this to runMigration's onProgress (step-level messages). */
  reportStep(msg: string): void {
    // msg is like 'config done', 'mcp done', 'sessions done'
    const key = msg.replace(/ done$/, '');
    if (this.stepStatus.has(key)) this.stepStatus.set(key, 'done');
  }

  /** Host wires this to runMigration's onSessionProgress. */
  reportSessionProgress(done: number, total: number): void {
    this.progressDone = done;
    this.progressTotal = total;
  }

  // The braille spinner advances on its own timer so the progress screen stays
  // visibly alive even while a single step (e.g. session translation) runs for
  // a while without emitting progress events. Runs only for the progress
  // phase: started on entering it, stopped the moment it ends.
  private startSpinner(): void {
    this.stopSpinner();
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.opts.requestRender?.();
    }, SPINNER_INTERVAL_MS);
    // A decorative timer must never keep the process alive on its own.
    this.spinnerTimer.unref();
  }

  private stopSpinner(): void {
    if (this.spinnerTimer !== undefined) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
  }

  // test hooks (thin aliases so tests don't depend on host wiring)
  _testEnterProgress(): void {
    this.enterProgress();
  }
  _testUpdateStep(msg: string): void {
    this.reportStep(msg);
  }
  _testUpdateSessionProgress(done: number, total: number): void {
    this.reportSessionProgress(done, total);
  }
  _testShowResult(report: MigrationReport): void {
    this.showResult(report);
  }

  handleInput(data: string): void {
    if (this.phase === 'ask1' || this.phase === 'ask2') {
      this.handleAskInput(data);
      return;
    }
    if (this.phase === 'result') {
      if (matchesKey(data, Key.enter)) {
        this.opts.onComplete({ decision: 'now', migrated: !this.migrationFailed });
      }
      return;
    }
    // progress phase: ignore input
  }

  private currentStep(): StepDef {
    return stepFor(this.phase, this.opts.plan);
  }

  private handleAskInput(data: string): void {
    const step = this.currentStep();
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(step.options.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      // Esc anywhere in ask == "later"
      this.opts.onComplete({ decision: 'later' });
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const chosen = step.options[this.selectedIndex];
      if (chosen === undefined) return;
      this.advance(chosen.value);
      return;
    }
  }

  /** Apply a chosen value and move the state machine forward. */
  private advance(value: AnyChoice): void {
    this.choices.push(value);
    this.selectedIndex = 0;

    const result: MigrationPromptResult = resolveMigrationScope(this.choices);
    if (this.phase === 'ask1') {
      if (value === 'now') {
        this.phase = 'ask2';
        return;
      }
      // 'later' | 'never'
      this.opts.onComplete({ decision: value as 'later' | 'never' });
      return;
    }
    // ask2 — either choice resolves the full scope; run migration immediately.
    this.beginMigration(result);
  }

  /** Enter the progress phase and run the migration to completion. */
  private beginMigration(result: MigrationPromptResult): void {
    if (result.decision !== 'now' || result.scope === undefined) {
      this.opts.onComplete({ decision: 'later' });
      return;
    }
    this.enterProgress();
    this.startSpinner();
    this.opts.requestRender?.();
    const run = this.opts.runMigration ?? realRunMigration;
    void run({
      plan: this.opts.plan,
      scope: result.scope,
      source: this.opts.sourceHome,
      target: this.opts.targetHome,
      onProgress: (msg) => {
        this.reportStep(msg);
        this.opts.requestRender?.();
      },
      onSessionProgress: (done, total) => {
        this.reportSessionProgress(done, total);
        this.opts.requestRender?.();
      },
    }).then(
      (report) => {
        this.showResult(report);
        this.opts.requestRender?.();
      },
      () => {
        this.showFailure();
        this.opts.requestRender?.();
      },
    );
  }

  override render(width: number): string[] {
    if (this.phase === 'ask1' || this.phase === 'ask2') {
      return this.renderAsk(width);
    }
    if (this.phase === 'progress') return this.renderProgress(width);
    return this.renderResult(width);
  }

  private renderResult(width: number): string[] {
    const { colors } = this.opts;
    const lines: string[] = [chalk.hex(colors.primary)('─'.repeat(width))];
    if (this.migrationFailed) {
      lines.push(chalk.hex(colors.error).bold(' 迁移失败'));
      lines.push('');
      lines.push(chalk.hex(colors.text)(' 可稍后运行 "scream migrate" 重试。'));
      lines.push('');
      lines.push(chalk.hex(colors.textMuted)(' ⏎ 继续进入 scream-code'));
      lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
      return lines.map((l) => truncateToWidth(l, width));
    }
    const r = this.report;
    lines.push(chalk.hex(colors.primary).bold(' 迁移完成'));
    lines.push('');
    if (r !== undefined) {
      const sum = r.summary;
      if (sum.sessions.sessionsMigrated > 0) {
        lines.push(
          chalk.hex(colors.success)(`  ✓ ${sum.sessions.sessionsMigrated} 个会话已迁移`),
        );
      }
      // Only claim a data class was migrated when the summary says it was —
      // a skipped/failed step (e.g. malformed config.toml) must not show ✓.
      const migratedKinds: string[] = [];
      if (sum.config.migrated) migratedKinds.push('config');
      if (sum.config.migratedHooks > 0) migratedKinds.push('hooks');
      if (sum.mcp.mergedServers.length > 0) migratedKinds.push('MCP');
      if (sum.userHistory.copied > 0) migratedKinds.push('REPL 历史');
      if (sum.skills.copied > 0) migratedKinds.push('技能');
      if (migratedKinds.length > 0) {
        lines.push(chalk.hex(colors.success)(`  ✓ ${migratedKinds.join(' · ')}`));
      }
      if (sum.sessions.sessionsMigrated === 0 && migratedKinds.length === 0) {
        lines.push(chalk.hex(colors.textMuted)('  无需迁移任何内容。'));
      }
      if (r.notices.detectedPlugins.length > 0) {
        lines.push(
          chalk.hex(colors.warning)(
            `  ⚠ ${r.notices.detectedPlugins.length} 个 scream-cli 插件 — 暂不支持迁移`,
          ),
        );
      }
      // OAuth credentials are deliberately not migrated (refresh tokens cannot
      // safely be held by two installs at once). scream-code's normal auth flow
      // will prompt for /login when the user first picks a model — surfacing a
      // separate notice here reads as a migration limitation, which it is not.
      if (sum.config.droppedHooks > 0) {
        lines.push(
          chalk.hex(colors.warning)(
            `  ⚠ ${sum.config.droppedHooks} 个 hook 不兼容，已丢弃`,
          ),
        );
      }
      // Conflicts and partial failures: the report records them, so surface
      // them here too — otherwise "✓ config / MCP" hides that the data only
      // landed in a *.migrated-from-scream-cli.* sibling or that sessions failed.
      if (sum.config.configConflicts.length > 0) {
        lines.push(
          chalk.hex(colors.warning)(
            `  ⚠ ${sum.config.configConflicts.length} 个配置冲突，保留了你本地的版本: ${sum.config.configConflicts.join(' · ')}`,
          ),
        );
      }
      if (sum.config.wroteSiblingDueToConflict) {
        // Sibling mode: the live config.toml could not be parsed, so the
        // migrated content went to `config.migrated-from-scream-cli.toml` and
        // the user must merge it by hand. Show the enumeration of contents
        // on a SEPARATE line below — a single-line message with the contents
        // appended would overflow 80 columns and be truncated, silently
        // hiding the very info we want users to see.
        lines.push(
          chalk.hex(colors.warning)(
            '  ⚠ config.toml 无法解析 — 请查看 config.migrated-from-scream-cli.toml',
          ),
        );
        const sc = sum.config.siblingContents;
        const items: string[] = [];
        if (sc.providers.length > 0) {
          items.push(`${sc.providers.length} 个 provider`);
        }
        if (sc.models.length > 0) {
          items.push(`${sc.models.length} 个 model`);
        }
        if (sc.hooks > 0) {
          items.push(`${sc.hooks} 个 hook`);
        }
        if (items.length > 0) {
          lines.push(chalk.hex(colors.warning)(`     包含: ${items.join(', ')}`));
        }
      }
      if (sum.config.wroteTuiSibling) {
        lines.push(
          chalk.hex(colors.warning)(
            '  ⚠ tui.toml 冲突 — 请检查 tui.migrated-from-scream-cli.toml',
          ),
        );
      }
      if (sum.mcp.wroteSiblingDueToConflict) {
        lines.push(
          chalk.hex(colors.warning)(
            '  ⚠ mcp.json 无法读取 — 请检查 mcp.migrated-from-scream-cli.json',
          ),
        );
      }
      if (r.notices.mcpOauthServersRequiringReauth.length > 0) {
        lines.push(
          chalk.hex(colors.warning)(
            `  ⚠ ${r.notices.mcpOauthServersRequiringReauth.length} 个 MCP 服务器需要重新认证`,
          ),
        );
      }
      if (sum.sessions.sessionsFailed.length > 0) {
        lines.push(
          chalk.hex(colors.warning)(
            `  ⚠ ${sum.sessions.sessionsFailed.length} 个会话迁移失败`,
          ),
        );
      }
      if (sum.sessions.sessionsConflicts.length > 0) {
        lines.push(
          chalk.hex(colors.warning)(
            `  ⚠ ${sum.sessions.sessionsConflicts.length} 个会话已跳过（目标位置已被占用）`,
          ),
        );
      }
      // Empty / user-cleared sessions carry no conversation — neutral info,
      // not a failure, so it is shown muted rather than as a ⚠ warning.
      if (sum.sessions.sessionsSkippedEmpty > 0) {
        lines.push(
          chalk.hex(colors.textMuted)(
            `  ${sum.sessions.sessionsSkippedEmpty} 个空会话已跳过`,
          ),
        );
      }
      lines.push('');
      lines.push(
        chalk.hex(colors.textMuted)(' 旧数据保留在 ~/.scream/ — scream-cli 仍可正常使用。'),
      );
    }
    lines.push('');
    lines.push(chalk.hex(colors.textMuted)(' ⏎ 继续进入 scream-code'));
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((l) => truncateToWidth(l, width));
  }

  private renderProgress(width: number): string[] {
    const { colors } = this.opts;
    const spinner = SPINNER_FRAMES[this.spinnerFrame] ?? SPINNER_FRAMES[0];
    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(' 正在从 scream-cli 迁移'),
      '',
    ];
    if (this.progressTotal > 0) {
      lines.push(
        chalk.hex(colors.accent)(`  ${spinner}  `) +
          chalk.hex(colors.text)(
            `正在转换会话…  ${this.progressDone} / ${this.progressTotal}`,
          ),
      );
      lines.push('');
    }
    for (const [key, label] of STEP_LABELS) {
      const status = this.stepStatus.get(key) ?? 'pending';
      const mark =
        status === 'done'
          ? chalk.hex(colors.success)('✓')
          : chalk.hex(colors.textDim)('◐');
      lines.push(`  ${mark} ${chalk.hex(colors.text)(label)}`);
    }
    lines.push('');
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((l) => truncateToWidth(l, width));
  }

  private renderAsk(width: number): string[] {
    const { colors } = this.opts;
    const step = this.currentStep();
    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(' 从 scream-cli 迁移'),
      '',
    ];
    if (this.phase === 'ask1') {
      lines.push(chalk.hex(colors.text)(' 发现已有的 scream-cli 安装:'));
      lines.push(chalk.hex(colors.textMuted)(`   ${summarizePlan(this.opts.plan)}`));
      lines.push('');
    }
    lines.push(chalk.hex(colors.text)(` ${step.title}`));
    lines.push('');
    for (let i = 0; i < step.options.length; i++) {
      const opt = step.options[i]!;
      const isSel = i === this.selectedIndex;
      const pointer = isSel ? '❯' : ' ';
      const labelStyle = isSel ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
      lines.push(
        chalk.hex(isSel ? colors.primary : colors.textDim)(`  ${pointer} `) +
          labelStyle(opt.label),
      );
    }
    lines.push('');
    lines.push(
      chalk.hex(colors.textMuted)(
        ` ↑/↓ 移动 · ⏎ 选择 · esc ${this.opts.skipDecisionStep === true ? '取消' : '稍后'}`,
      ),
    );
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((l) => truncateToWidth(l, width));
  }
}

function summarizePlan(plan: MigrationPlan): string {
  const parts: string[] = [];
  if (plan.totalSessions > 0) parts.push(`${plan.totalSessions} 个会话`);
  if (plan.hasConfig) parts.push('config.toml');
  if (plan.hasMcp) parts.push('mcp.json');
  if (plan.hasUserHistory) parts.push('REPL 历史');
  return parts.join(' · ');
}

function stepFor(phase: Phase, plan: MigrationPlan): StepDef {
  if (phase === 'ask1') {
    return {
      title: '是否将此数据迁移到 scream-code?',
      options: [
        { label: '立即迁移', value: 'now' satisfies Prompt1Choice },
        { label: '稍后询问', value: 'later' satisfies Prompt1Choice },
        { label: '不再询问', value: 'never' satisfies Prompt1Choice },
      ],
    };
  }
  // ask2 — the second option carries the actual session count so users can see
  // the cost they are signing up for. Falls back to the singular "sessions"
  // word only (no count) when no sessions were detected.
  const sessionsLabel =
    plan.totalSessions > 0
      ? `配置 + ${plan.totalSessions} 个会话`
      : '配置 + 所有会话';
  return {
    title: '是否同时迁移聊天会话?（数据量较大且速度较慢）',
    options: [
      { label: '仅配置', value: 'config-only' satisfies Prompt2Choice },
      { label: sessionsLabel, value: 'all-sessions' satisfies Prompt2Choice },
    ],
  };
}

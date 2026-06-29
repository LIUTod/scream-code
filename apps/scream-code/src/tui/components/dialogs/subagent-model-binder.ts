/**
 * `/model diy` — bind a model alias to each built-in subagent profile.
 *
 * Two-level picker:
 *   1. Profile list (coder / reviewer / writer / explore / oracle / plan / verify)
 *      showing each profile's current binding.
 *   2. Model selector: "跟随主模型" (unbind) + every configured model alias.
 *
 * Bindings persist to `tui.toml` and update live AppState, so mid-session
 * changes take effect on the next subagent spawn without recreating the session.
 */

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';
import { modelDisplayName } from './model-selector';
import {
  getTuiConfigPath,
  loadTuiConfig,
  saveTuiConfig,
  type TuiConfig,
} from '#/tui/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

const FOLLOW_MAIN = '__follow_main__';

const SUBAGENT_PROFILES: readonly {
  readonly name: string;
  readonly description: string;
}[] = [
  { name: 'coder', description: '通用软件工程任务' },
  { name: 'reviewer', description: '代码审查，发现 bug 和 API 契约违反' },
  { name: 'writer', description: '内容生产与研究报告' },
  { name: 'explore', description: '快速代码库探索（只读）' },
  { name: 'oracle', description: '深度调试与架构决策' },
  { name: 'plan', description: '实现规划与架构设计（只读）' },
  { name: 'verify', description: '运行构建/测试/lint 验证改动' },
];

export function showSubagentModelBinder(host: SlashCommandHost): void {
  mountProfileList(host);
}

function mountProfileList(host: SlashCommandHost): void {
  const { subagentModels: bindings, availableModels } = host.state.appState;
  const options: ChoiceOption[] = SUBAGENT_PROFILES.map((profile) => {
    const alias = bindings[profile.name];
    const bindingLabel =
      alias === undefined
        ? '跟随主模型'
        : modelDisplayName(alias, availableModels[alias]);
    return {
      value: profile.name,
      label: `${profile.name}  →  ${bindingLabel}`,
      description: profile.description,
    };
  });

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: '子代理模型绑定',
      hint: '↑↓ 选择子代理 · Enter 绑定模型 · Esc 取消',
      options,
      colors: host.state.theme.colors,
      onSelect: (profileName) => {
        mountModelPicker(host, profileName);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function mountModelPicker(host: SlashCommandHost, profileName: string): void {
  const { subagentModels: bindings, availableModels } = host.state.appState;
  const currentBinding = bindings[profileName] ?? FOLLOW_MAIN;

  const options: ChoiceOption[] = [
    {
      value: FOLLOW_MAIN,
      label: '跟随主模型',
      description: '使用主代理当前模型（默认）',
    },
    ...Object.entries(availableModels).map(([alias, cfg]) => ({
      value: alias,
      label: modelDisplayName(alias, cfg),
    })),
  ];

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: `绑定 ${profileName}`,
      hint: '↑↓ 选择模型 · Enter 确认 · Esc 返回',
      options,
      currentValue: currentBinding,
      colors: host.state.theme.colors,
      searchable: true,
      onSelect: (value) => {
        void applyBinding(host, profileName, value);
      },
      onCancel: () => {
        mountProfileList(host);
      },
    }),
  );
}

async function applyBinding(
  host: SlashCommandHost,
  profileName: string,
  value: string,
): Promise<void> {
  const configPath = getTuiConfigPath();
  try {
    const current = await loadTuiConfig(configPath);
    const updated: Record<string, string> = { ...current.subagentModels };
    if (value === FOLLOW_MAIN) {
      delete updated[profileName];
    } else {
      updated[profileName] = value;
    }
    const newConfig: TuiConfig = { ...current, subagentModels: updated };
    await saveTuiConfig(newConfig, configPath);
    host.setAppState({ subagentModels: updated });
    const label =
      value === FOLLOW_MAIN
        ? '跟随主模型'
        : modelDisplayName(value, host.state.appState.availableModels[value]);
    host.showStatus(`${profileName} → ${label}`, host.state.theme.colors.success);
  } catch (error) {
    host.showError(`保存失败：${error instanceof Error ? error.message : String(error)}`);
  }
  mountProfileList(host);
}

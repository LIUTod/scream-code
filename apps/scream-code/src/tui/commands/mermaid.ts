/**
 * /mermaid — 选择 Mermaid 图的渲染方式。
 *
 * 弹面板，三档：开 / 双宽模式 / 关。选择写入 ui-preferences.json，重启保留。
 * 「双宽模式」用 ASCII 边框代替制表符，给那些把制表符画成两格宽的终端用 ——
 * 那种终端下正常边框会整幅错位。
 *
 * 也可以直接带参数跳过面板：`/mermaid on|ascii|off`。
 */

import { t } from '@scream-code/config';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { getMermaidDisplay, setMermaidDisplay, type MermaidDisplay } from '../utils/ui-preferences';
import { repaintTranscript } from '../utils/transcript-repaint';
import { syncDiagramCapabilityPrompt } from '../utils/terminal-diagram-prompt';

import type { SlashCommandHost } from './dispatch';

const DISPLAYS: readonly MermaidDisplay[] = ['on', 'ascii', 'off'];

function optionLabel(value: MermaidDisplay): string {
  return t(`mermaid.option.${value}`);
}

function buildOptions(): ChoiceOption[] {
  return DISPLAYS.map((value) => ({
    value,
    label: optionLabel(value),
    description: t(`mermaid.desc.${value}`),
    tone: value === 'off' ? ('danger' as const) : undefined,
  }));
}

/** Apply a choice: redraw what is already on screen, restate the capability. */
async function applyDisplay(host: SlashCommandHost, value: MermaidDisplay): Promise<void> {
  setMermaidDisplay(value);
  host.showStatus(
    t('mermaid.applied', { mode: optionLabel(value) }),
    value === 'off' ? host.state.theme.colors.textDim : host.state.theme.colors.success,
  );
  // Frames already on screen were laid out under the previous choice.
  repaintTranscript(host);
  // Telling the model it can draw diagrams has to follow the switch: leaving the
  // statement in place after `off` would have it producing fences this terminal
  // now shows as source.
  await syncDiagramCapabilityPrompt(host.session);
}

export async function handleMermaidCommand(host: SlashCommandHost, args: string): Promise<void> {
  const choice = args.trim().toLowerCase();

  // A bare `/mermaid` asks; an explicit value skips the question.
  if ((DISPLAYS as readonly string[]).includes(choice)) {
    await applyDisplay(host, choice as MermaidDisplay);
    return;
  }

  if (choice !== '') {
    host.showStatus(t('mermaid.usage'), host.state.theme.colors.textDim);
    return;
  }

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: t('mermaid.picker_title'),
      hint: t('mermaid.picker_hint'),
      options: buildOptions(),
      currentValue: getMermaidDisplay(),
      colors: host.state.theme.colors,
      onSelect: (value) => {
        host.restoreEditor();
        void applyDisplay(host, value as MermaidDisplay);
      },
      onCancel: () => {
        host.restoreEditor();
        host.showStatus(
          t('mermaid.picker_cancelled', { mode: optionLabel(getMermaidDisplay()) }),
          host.state.theme.colors.textDim,
        );
      },
    }),
  );
}

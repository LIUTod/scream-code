import { describe, expect, it, vi } from 'vitest';

import {
  useSlashCommands,
  type SlashCommandHandlers,
} from '../../src/web/frontend/src/composables/useSlashCommands';

function makeHandlers(overrides: Partial<SlashCommandHandlers> = {}) {
  const sendCommand = vi.fn();
  const clearMessages = vi.fn();
  const appendSystemMessage = vi.fn();
  const onNew = vi.fn();
  const handlers: SlashCommandHandlers = {
    sendCommand,
    clearMessages,
    appendSystemMessage,
    onNew,
    ...overrides,
  };
  return { handlers, sendCommand, clearMessages, appendSystemMessage, onNew };
}

describe('useSlashCommands', () => {
  it('forwards session commands with args (title)', async () => {
    const h = makeHandlers();
    const { onCommand } = useSlashCommands(h.handlers);
    await onCommand('title', '新标题');
    expect(h.sendCommand).toHaveBeenCalledWith('title', '新标题');
  });

  it('forwards every session command verbatim', async () => {
    const h = makeHandlers();
    const { onCommand } = useSlashCommands(h.handlers);
    for (const name of ['compact', 'auto', 'yes', 'plan', 'fork', 'btw']) {
      await onCommand(name);
      expect(h.sendCommand).toHaveBeenCalledWith(name, undefined);
    }
  });

  it('awaits ensureSession before sending when no session exists', async () => {
    const order: string[] = [];
    const ensureSession = vi.fn(async () => {
      order.push('ensure');
    });
    const h = makeHandlers({
      ensureSession,
      sendCommand: vi.fn(() => {
        order.push('send');
      }),
    });
    const { onCommand } = useSlashCommands(h.handlers);
    await onCommand('compact');
    expect(ensureSession).toHaveBeenCalledOnce();
    expect(order).toEqual(['ensure', 'send']);
  });

  it('sends directly when no ensureSession hook is given', async () => {
    const h = makeHandlers();
    const { onCommand } = useSlashCommands(h.handlers);
    await onCommand('compact');
    expect(h.sendCommand).toHaveBeenCalledWith('compact', undefined);
  });

  it('clear clears messages without touching the session', async () => {
    const h = makeHandlers();
    const { onCommand } = useSlashCommands(h.handlers);
    await onCommand('clear');
    expect(h.clearMessages).toHaveBeenCalledOnce();
    expect(h.sendCommand).not.toHaveBeenCalled();
  });

  it('new delegates to the onNew hook', async () => {
    const h = makeHandlers();
    const { onCommand } = useSlashCommands(h.handlers);
    await onCommand('new');
    expect(h.onNew).toHaveBeenCalledOnce();
  });

  it('help prints the slash help text', async () => {
    const h = makeHandlers();
    const { onCommand } = useSlashCommands(h.handlers);
    await onCommand('help');
    expect(h.appendSystemMessage).toHaveBeenCalledOnce();
    const text = h.appendSystemMessage.mock.calls[0]?.[0] as string;
    expect(text.length).toBeGreaterThan(0);
  });

  it('model opens the picker when available and prints nothing', async () => {
    const openModelPicker = vi.fn(() => true);
    const h = makeHandlers({ openModelPicker });
    const { onCommand } = useSlashCommands(h.handlers);
    await onCommand('model');
    expect(openModelPicker).toHaveBeenCalledOnce();
    expect(h.appendSystemMessage).not.toHaveBeenCalled();
  });

  it('model falls back to a status message when the picker cannot open', async () => {
    const openModelPicker = vi.fn(() => false);
    const h = makeHandlers({ openModelPicker, currentModel: () => 'm1' });
    const { onCommand } = useSlashCommands(h.handlers);
    await onCommand('model');
    expect(h.appendSystemMessage).toHaveBeenCalledWith('当前模型：m1');
  });

  it('model without a picker host prints the current model', async () => {
    const h = makeHandlers({ currentModel: () => 'm2' });
    const { onCommand } = useSlashCommands(h.handlers);
    await onCommand('model');
    expect(h.appendSystemMessage).toHaveBeenCalledWith('当前模型：m2');
  });

  it('model fallback reports unknown when no model name is available', async () => {
    const h = makeHandlers({ currentModel: () => null });
    const { onCommand } = useSlashCommands(h.handlers);
    await onCommand('model');
    expect(h.appendSystemMessage).toHaveBeenCalledWith('当前模型：unknown');
  });

  it('status and usage open the info panel when the host provides one', async () => {
    const showInfo = vi.fn();
    const h = makeHandlers({ showInfo });
    const { onCommand } = useSlashCommands(h.handlers);
    await onCommand('status');
    await onCommand('usage');
    expect(showInfo).toHaveBeenNthCalledWith(1, 'status');
    expect(showInfo).toHaveBeenNthCalledWith(2, 'usage');
    expect(h.appendSystemMessage).not.toHaveBeenCalled();
  });

  it('status falls back to the hint message without an info panel', async () => {
    const h = makeHandlers();
    const { onCommand } = useSlashCommands(h.handlers);
    await onCommand('status');
    expect(h.appendSystemMessage).toHaveBeenCalledWith('请在对话页查看会话详情');
  });

  it('unknown commands are reported', async () => {
    const h = makeHandlers();
    const { onCommand } = useSlashCommands(h.handlers);
    await onCommand('frobnicate');
    expect(h.appendSystemMessage).toHaveBeenCalledWith('未知命令：/frobnicate');
  });
});

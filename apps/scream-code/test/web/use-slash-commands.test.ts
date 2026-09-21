import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  useSlashCommands,
  type SlashCommandHandlers,
} from '../../src/web/frontend/src/composables/useSlashCommands';
import { setSlashSkills } from '../../src/web/frontend/src/commands';
import { useToast } from '../../src/web/frontend/src/composables/useToast';
import {
  registerActiveWebClient,
  unregisterActiveWebClient,
} from '../../src/web/frontend/src/composables/webClient/activeClient';

let registeredControlClient: object | null = null;

function registerControlClient(overrides: Record<string, unknown> = {}) {
  const client = {
    sessionId: { value: 'session-1' },
    status: {
      value: {
        busy: false,
        wolfpackMode: false,
        rlmEnabled: false,
        planMode: false,
        planStrategy: 'normal',
      },
    },
    isBusy: { value: false },
    switchWolfpack: vi.fn(async () => true),
    switchRlm: vi.fn(async () => true),
    switchPlanMode: vi.fn(async () => true),
    undoHistory: vi.fn(async () => true),
    fetchSnapshot: vi.fn(async () => undefined),
    ...overrides,
  };
  registeredControlClient = client;
  registerActiveWebClient(client as never);
  return client;
}

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

// The toast state is a module-level singleton: clear it per test to avoid
// cross-test bleed.
afterEach(() => {
  const { toasts, removeToast } = useToast();
  [...toasts.value].forEach((t) => removeToast(t.id));
  setSlashSkills([]);
  if (registeredControlClient !== null) {
    unregisterActiveWebClient(registeredControlClient as never);
    registeredControlClient = null;
  }
});

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
    for (const name of ['compact', 'auto', 'ask', 'yes', 'bot', 'plan', 'fork', 'btw']) {
      await onCommand(name);
      expect(h.sendCommand).toHaveBeenCalledWith(name, undefined);
    }
  });

  it('/bot ensures a session before forwarding (the server handleCommand has a bot branch)', async () => {
    const ensureSession = vi.fn(async () => undefined);
    const h = makeHandlers({ ensureSession });
    const { onCommand } = useSlashCommands(h.handlers);
    await onCommand('bot');
    expect(ensureSession).toHaveBeenCalledOnce();
    expect(h.sendCommand).toHaveBeenCalledWith('bot', undefined);
    expect(useToast().toasts.value.some((t) => t.message.includes('未知命令'))).toBe(false);
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

  it('raises a toast for an unknown command instead of only printing a system message row', async () => {
    const h = makeHandlers();
    const { onCommand } = useSlashCommands(h.handlers);
    await onCommand('frobnicate');
    expect(h.appendSystemMessage).not.toHaveBeenCalled();
    const toast = useToast().toasts.value.find((t) => t.message.includes('未知命令'));
    expect(toast?.message).toBe('未知命令：/frobnicate');
    expect(toast?.type).toBe('error');
  });

  it('a name matching an injected skill goes through skill activation (onSkill hook + toast feedback)', async () => {
    setSlashSkills([{ name: 'web-clone', description: '复刻网站', source: 'user' }]);
    const onSkill = vi.fn(async () => true);
    const ensureSession = vi.fn(async () => undefined);
    const h = makeHandlers({ onSkill, ensureSession });
    const { onCommand } = useSlashCommands(h.handlers);
    await onCommand('web-clone', '某个网站');
    expect(ensureSession).toHaveBeenCalledOnce();
    expect(onSkill).toHaveBeenCalledWith('web-clone', '某个网站');
    expect(h.sendCommand).not.toHaveBeenCalled();
    expect(useToast().toasts.value.some((t) => t.message.includes('技能已激活：/web-clone'))).toBe(true);
  });

  it('without an onSkill hook it falls back to the active client registry; a failure raises an error toast', async () => {
    setSlashSkills([{ name: 'push', description: '门', source: 'extra' }]);
    const activateSkill = vi.fn(async () => false);
    const fake = { activateSkill } as never;
    registerActiveWebClient(fake);
    const h = makeHandlers();
    const { onCommand } = useSlashCommands(h.handlers);
    await onCommand('push');
    expect(activateSkill).toHaveBeenCalledWith('push', undefined);
    expect(
      useToast()
        .toasts.value.some((t) => t.message.includes('技能激活失败：/push') && t.type === 'error'),
    ).toBe(true);
    unregisterActiveWebClient(fake);
    setSlashSkills([]);
  });

  it('executes /wolfpack with TUI-compatible toggle and explicit arguments', async () => {
    const client = registerControlClient();
    const h = makeHandlers();
    const { onCommand } = useSlashCommands(h.handlers);

    await onCommand('wolfpack');
    expect(client.switchWolfpack).toHaveBeenCalledWith(true);

    (client.status as { value: { wolfpackMode: boolean } }).value.wolfpackMode = true;
    await onCommand('wolfpack', 'off');
    expect(client.switchWolfpack).toHaveBeenLastCalledWith(false);
  });

  it('executes /rlm and preserves the current mode when setting /rlm-max-depth', async () => {
    const client = registerControlClient();
    const h = makeHandlers();
    const { onCommand } = useSlashCommands(h.handlers);

    await onCommand('rlm', 'on');
    expect(client.switchRlm).toHaveBeenCalledWith(true);

    (client.status as { value: { rlmEnabled: boolean } }).value.rlmEnabled = true;
    await onCommand('rlm-max-depth', '3');
    expect(client.switchRlm).toHaveBeenCalledWith(true, 3);
  });

  it('rejects invalid RLM depth and explains a query without sending a mutation', async () => {
    const client = registerControlClient();
    const h = makeHandlers();
    const { onCommand } = useSlashCommands(h.handlers);

    await onCommand('rlm-max-depth', '-1');
    await onCommand('rlm-max-depth');
    expect(client.switchRlm).not.toHaveBeenCalled();
    expect(h.appendSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/rlm-max-depth <N>'));
  });

  it('maps /fusionplan toggle semantics to the fusion REST strategy', async () => {
    const client = registerControlClient();
    const h = makeHandlers();
    const { onCommand } = useSlashCommands(h.handlers);

    await onCommand('fusionplan');
    expect(client.switchPlanMode).toHaveBeenCalledWith(true, 'fusion');

    (client.status as { value: { planMode: boolean; planStrategy: string } }).value.planMode = true;
    (client.status as { value: { planMode: boolean; planStrategy: string } }).value.planStrategy = 'fusion';
    await onCommand('fusionplan');
    expect(client.switchPlanMode).toHaveBeenLastCalledWith(false, undefined);
  });

  it('executes /revoke with a validated turn count and refreshes the transcript', async () => {
    const client = registerControlClient();
    const h = makeHandlers();
    const { onCommand } = useSlashCommands(h.handlers);

    await onCommand('revoke', '2');
    expect(client.undoHistory).toHaveBeenCalledWith(2);
    expect(client.fetchSnapshot).toHaveBeenCalledOnce();

    (client.isBusy as { value: boolean }).value = true;
    await onCommand('revoke', '1');
    expect(client.undoHistory).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it } from 'vitest';

import {
  handleAskCommand,
  handleAutoCommand,
  handleBotCommand,
  handleYoloCommand,
} from '#/tui/commands/config';

import { createMockAppState, makeMockSession, makeMockSlashCommandHost } from '../fixtures/mock-host';

describe('permission mode commands', () => {
  it('switches /yes off to the unattended bot mode', async () => {
    const session = makeMockSession();
    const host = makeMockSlashCommandHost({
      session,
      appState: createMockAppState({ permissionMode: 'yolo' }),
    });

    await handleYoloCommand(host, 'off');

    expect(session.setPermission).toHaveBeenCalledWith('bot');
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'bot' });
  });

  it('switches the /yes toggle off to the unattended bot mode', async () => {
    const session = makeMockSession();
    const host = makeMockSlashCommandHost({
      session,
      appState: createMockAppState({ permissionMode: 'yolo' }),
    });

    await handleYoloCommand(host, '');

    expect(session.setPermission).toHaveBeenCalledWith('bot');
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'bot' });
  });

  it('switches /bot off back to the startup default', async () => {
    const session = makeMockSession();
    const host = makeMockSlashCommandHost({
      session,
      appState: createMockAppState({ permissionMode: 'bot' }),
    });

    await handleBotCommand(host, 'off');

    expect(session.setPermission).toHaveBeenCalledWith('yolo');
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'yolo' });
  });

  it('switches /auto off to yolo', async () => {
    const session = makeMockSession();
    const host = makeMockSlashCommandHost({
      session,
      appState: createMockAppState({ permissionMode: 'auto' }),
    });

    await handleAutoCommand(host, 'off');

    expect(session.setPermission).toHaveBeenCalledWith('yolo');
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'yolo' });
  });

  it('switches /ask off to yolo', async () => {
    const session = makeMockSession();
    const host = makeMockSlashCommandHost({
      session,
      appState: createMockAppState({ permissionMode: 'ask' }),
    });

    await handleAskCommand(host, 'off');

    expect(session.setPermission).toHaveBeenCalledWith('yolo');
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'yolo' });
  });
});

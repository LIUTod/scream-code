/// <reference types="vite/client" />
// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';

import type { Bot } from '../../../src/bot/shared/contracts';
import { queryKeys } from '../../../src/bot/ui/lib/api/queries';
import {
  forgetDeletedBot,
  readActiveBot,
  rememberActiveBot,
} from '../../../src/bot/ui/lib/session';

function bot(id: string): Bot {
  return {
    id,
    name: id,
    title: '',
    rolePrompt: '',
    avatarSeed: id,
    workspace: '/workspace',
    model: undefined,
    thinking: undefined,
    permission: 'bot',
    toolPolicy: {},
    paused: false,
    status: 'idle',
    unread: 0,
    needsYou: 0,
    lastActiveAt: null,
  };
}

afterEach(() => {
  window.localStorage.clear();
});

describe('deleted Bot selection', () => {
  it('clears the active selection and both caches before Landing can redirect', () => {
    const client = new QueryClient();
    const deleted = bot('bot_deleted');
    const remaining = bot('bot_remaining');
    client.setQueryData(queryKeys.bots(), [deleted, remaining]);
    client.setQueryData(queryKeys.bot(deleted.id), deleted);
    client.setQueryData(queryKeys.bot(remaining.id), remaining);
    rememberActiveBot(deleted.id);

    forgetDeletedBot(deleted.id, client);

    expect(readActiveBot()).toBeNull();
    expect(client.getQueryState(queryKeys.bot(deleted.id))).toBeUndefined();
    expect(client.getQueryData(queryKeys.bots())).toEqual([remaining]);
    expect(client.getQueryData(queryKeys.bot(remaining.id))).toEqual(remaining);
    // Landing evaluates these synchronously as soon as navigation mounts it.
    const target = client.getQueryData<Bot[]>(queryKeys.bots())?.find(
      (entry) => entry.id === readActiveBot(),
    );
    expect(target).toBeUndefined();
    client.clear();
  });

  it('preserves another active Bot and does not manufacture an absent list cache', () => {
    const client = new QueryClient();
    const deleted = bot('bot_deleted');
    client.setQueryData(queryKeys.bot(deleted.id), deleted);
    rememberActiveBot('bot_remaining');

    forgetDeletedBot(deleted.id, client);

    expect(readActiveBot()).toBe('bot_remaining');
    expect(client.getQueryState(queryKeys.bot(deleted.id))).toBeUndefined();
    expect(client.getQueryState(queryKeys.bots())).toBeUndefined();
    client.clear();
  });
});

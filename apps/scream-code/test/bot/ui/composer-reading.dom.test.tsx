// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot, Run } from '../../../src/bot/shared/contracts';
import { getBotClient } from '../../../src/bot/ui/lib/api/client';

import { Composer } from '../../../src/bot/ui/components/chat/composer';
import { I18nProvider } from '../../../src/bot/ui/lib/i18n';
const caches: QueryClient[] = [];
let sequence = 0;
function bot(paused = false): Bot {
  return {
    id: `bot_reading_${++sequence}`, name: 'Reader', title: '', rolePrompt: '', avatarSeed: '',
    workspace: '/workspace', model: undefined, thinking: undefined, permission: 'bot', toolPolicy: {},
    paused, status: 'idle', unread: 0, needsYou: 0, lastActiveAt: null,
  };
}
function mount(current: Bot, threadId = 'thread_a', runs: Run[] = []) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  caches.push(cache);
  cache.setQueryData(['runs', current.id], runs);
  const view = (selected: Bot, thread: string) => (
    <QueryClientProvider client={cache}><I18nProvider><Composer bot={selected} threadId={thread} /></I18nProvider></QueryClientProvider>
  );
  const screen = render(view(current, threadId));
  return { ...screen, cache, switchTo: (selected: Bot, thread: string) => { screen.rerender(view(selected, thread)); } };
}
beforeEach(() => {
  localStorage.setItem('scream.bot.lang', 'en');
  vi.spyOn(getBotClient(), 'listRuns').mockResolvedValue([]);
  vi.spyOn(getBotClient(), 'listMessages').mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  for (const cache of caches.splice(0)) cache.clear();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('composer request ownership', () => {
  it('keeps text typed during a slow successful POST', async () => {
    const post = Promise.withResolvers<{ runId: string }>();
    const prompt = vi.spyOn(getBotClient(), 'prompt').mockReturnValue(post.promise);
    const current = bot();
    const screen = mount(current);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first' } });
    fireEvent.click(screen.getByLabelText('Send'));
    await waitFor(() => { expect(prompt).toHaveBeenCalledOnce(); });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'second' } });
    await act(async () => { post.resolve({ runId: 'run_a' }); });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('second');
  });

  it('refuses Enter and suggestions while paused, just like the Send button', async () => {
    const prompt = vi.spyOn(getBotClient(), 'prompt').mockResolvedValue({ runId: 'unused' });
    const screen = mount(bot(true));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'do not send' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    fireEvent.click(screen.getByText('Run the tests and fix what fails'));
    await act(async () => { await Promise.resolve(); });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('retains a slow failure separately from newer words without retrying automatically', async () => {
    const post = Promise.withResolvers<{ runId: string }>();
    const prompt = vi.spyOn(getBotClient(), 'prompt').mockReturnValue(post.promise);
    const screen = mount(bot());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'original' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => { expect(prompt).toHaveBeenCalledOnce(); });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new words' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    fireEvent.click(screen.getByText('Run the tests and fix what fails'));
    await act(async () => { post.reject(new Error('offline')); });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('new words');
    expect(screen.container.querySelector('[data-slot="unconfirmed-prompt"] pre')?.textContent).toBe('original');
    expect(screen.getByRole('alert').textContent).toContain('offline');
    expect(prompt).toHaveBeenCalledOnce();
    prompt.mockResolvedValue({ runId: 'retried' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry original request' }));
    await waitFor(() => { expect(prompt).toHaveBeenCalledTimes(2); });
    expect(prompt).toHaveBeenLastCalledWith('thread_a', prompt.mock.calls[0]![1]);
    await waitFor(() => { expect(screen.container.querySelector('[data-slot="unconfirmed-prompt"]')).toBeNull(); });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('new words');
  });

  it.each([
    { outcome: 'success', sameBot: false }, { outcome: 'failure', sameBot: false },
    { outcome: 'success', sameBot: true }, { outcome: 'failure', sameBot: true },
  ])('settles $outcome only in its originating thread (same Bot: $sameBot)', async ({ outcome, sameBot }) => {
    const post = Promise.withResolvers<{ runId: string }>();
    const prompt = vi.spyOn(getBotClient(), 'prompt').mockReturnValue(post.promise);
    const current = bot();
    const screen = mount(current);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A original' } });
    fireEvent.click(screen.getByLabelText('Send'));
    await waitFor(() => { expect(prompt).toHaveBeenCalledOnce(); });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A newer' } });
    const other = sameBot ? current : bot();
    screen.cache.setQueryData(['runs', other.id], []);
    screen.switchTo(other, 'thread_b');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'B untouched' } });
    await act(async () => {
      if (outcome === 'success') post.resolve({ runId: 'accepted' });
      else post.reject(new Error('A failed'));
    });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('B untouched');
    expect(screen.queryByRole('alert')).toBeNull();
    screen.switchTo(current, 'thread_a');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('A newer');
    expect(screen.container.querySelector('[data-slot="unconfirmed-prompt"] pre')?.textContent ?? null).toBe(outcome === 'success' ? null : 'A original');
  });

  it('shows a failed stop and allows an explicit retry', async () => {
    const current = bot();
    const run: Run = { id: 'running', botId: current.id, threadId: 'thread_a', status: 'running', startedAt: 1, endedAt: null, error: null };
    const interrupt = vi.spyOn(getBotClient(), 'interrupt').mockRejectedValue(new Error('cannot stop'));
    const screen = mount(current, 'thread_a', [run]);
    vi.mocked(getBotClient().listRuns).mockResolvedValue([run]);
    fireEvent.click(screen.getByLabelText('Stop this run'));
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('cannot stop'); });
    interrupt.mockResolvedValue(undefined);
    fireEvent.click(screen.getByLabelText('Stop this run'));
    await waitFor(() => { expect(interrupt).toHaveBeenCalledTimes(2); });
  });

  it('shows a failed queued cancellation without hiding the server-owned item', async () => {
    const current = bot();
    const run: Run = { id: 'queued', botId: current.id, threadId: 'thread_a', status: 'queued', startedAt: 1, endedAt: null, error: null };
    const cancel = vi.spyOn(getBotClient(), 'cancelRun').mockRejectedValue(new Error('cannot cancel'));
    const screen = mount(current, 'thread_a', [run]);
    vi.mocked(getBotClient().listRuns).mockResolvedValue([run]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued task' }));
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('cannot cancel'); });
    expect(cancel).toHaveBeenCalledWith('queued');
    expect(screen.getByRole('button', { name: 'Cancel queued task' })).toBeTruthy();
  });

  it('submits a correction through the same guard and preserves its mode/key on explicit retry', async () => {
    const current = bot();
    const run: Run = { id: 'active', botId: current.id, threadId: 'thread_a', status: 'running', startedAt: 1, endedAt: null, error: null };
    const post = Promise.withResolvers<{ runId: string }>();
    const prompt = vi.spyOn(getBotClient(), 'prompt').mockReturnValue(post.promise);
    const screen = mount(current, 'thread_a', [run]);
    vi.mocked(getBotClient().listRuns).mockResolvedValue([run]);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'correct course' } });
    fireEvent.click(screen.getByRole('button', { name: 'Correct this run' }));
    await waitFor(() => { expect(prompt).toHaveBeenCalledOnce(); });
    const first = prompt.mock.calls[0]![1];
    expect(first).toMatchObject({ text: 'correct course', mode: 'steer', requestKey: expect.any(String) });
    await act(async () => { post.reject(new Error('response lost')); });
    prompt.mockResolvedValue({ runId: 'same_key' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry original request' }));
    await waitFor(() => { expect(prompt).toHaveBeenCalledTimes(2); });
    expect(prompt.mock.calls[1]![1]).toEqual(first);
  });

  it('sending a suggestion does not consume text already being drafted', async () => {
    const post = Promise.withResolvers<{ runId: string }>();
    const prompt = vi.spyOn(getBotClient(), 'prompt').mockReturnValue(post.promise);
    const screen = mount(bot());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep editing' } });
    fireEvent.click(screen.getByText('Run the tests and fix what fails'));
    await waitFor(() => { expect(prompt).toHaveBeenCalledOnce(); });
    await act(async () => { post.resolve({ runId: 'suggestion' }); });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('keep editing');
    expect(prompt).toHaveBeenCalledOnce(); // Accepted requests are never drained again by the UI.
  });

  it('keeps Shift+Enter and IME composition out of the submit path', async () => {
    const prompt = vi.spyOn(getBotClient(), 'prompt').mockResolvedValue({ runId: 'unused' });
    const screen = mount(bot());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true });
    await act(async () => { await Promise.resolve(); });
    expect(prompt).not.toHaveBeenCalled();
  });
});

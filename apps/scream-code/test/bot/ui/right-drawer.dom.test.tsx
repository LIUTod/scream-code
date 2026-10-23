// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { ComponentType, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot, Run } from '../../../src/bot/shared/contracts';
import { getBotClient } from '../../../src/bot/ui/lib/api/client';
import type { FileListing, FilePreview } from '../../../src/bot/ui/lib/client';

// Keep browser alias resolution in the DOM project, not the CLI typecheck.
const drawerPath = '../../../src/bot/ui/components/shell/right-drawer';
const palettePath = '../../../src/bot/ui/components/shell/command-palette';
const i18nPath = '../../../src/bot/ui/lib/i18n';
const { RightDrawer }: { RightDrawer: ComponentType<{ bot: Bot; threadId?: string }> } = await import(drawerPath);
const { CommandPalette }: { CommandPalette: ComponentType<{ open: boolean; onOpenChange: (open: boolean) => void }> } = await import(palettePath);
const { I18nProvider }: { I18nProvider: ComponentType<{ children: ReactNode }> } = await import(i18nPath);
const caches: QueryClient[] = [];
const bot: Bot = { id: 'reader', name: 'Reader', title: 'Files', workspace: '/new-default', rolePrompt: '', avatarSeed: '', model: undefined, thinking: undefined, permission: 'bot', toolPolicy: {}, paused: false, status: 'idle', unread: 0, needsYou: 0, lastActiveAt: null };
function cache() {
  const value = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  caches.push(value);
  return value;
}
function providers(content: ReactNode, value: QueryClient) {
  return <QueryClientProvider client={value}><I18nProvider>{content}</I18nProvider></QueryClientProvider>;
}
function mount(threadId: string | undefined = 'thread_a') {
  const value = cache();
  const tree = (thread: string | undefined) => providers(<RightDrawer bot={bot} threadId={thread} />, value);
  const screen = render(tree(threadId));
  return { ...screen, cache: value, switchThread: (thread: string | undefined) => { screen.rerender(tree(thread)); } };
}
function mountRouter(content: ReactNode) {
  const root = createRootRoute({ component: () => <>{content}</> });
  const route = createRoute({ getParentRoute: () => root, path: '/' });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  const value = cache();
  const screen = render(providers(<RouterProvider router={router} />, value));
  return { ...screen, cache: value, router };
}
beforeEach(() => {
  localStorage.setItem('scream.bot.lang', 'en');
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  vi.spyOn(getBotClient(), 'listBots').mockResolvedValue([bot]);
  vi.spyOn(getBotClient(), 'listRooms').mockResolvedValue([]);
  vi.spyOn(getBotClient(), 'listRuns').mockResolvedValue([]);
  vi.spyOn(getBotClient(), 'listActivity').mockResolvedValue([]);
  vi.spyOn(getBotClient(), 'listInbox').mockResolvedValue({ approvals: [], questions: [], handoffs: [] });
  vi.spyOn(getBotClient(), 'listFiles').mockResolvedValue({ path: '/actual-thread', entries: [] });
});
afterEach(() => {
  cleanup();
  for (const value of caches.splice(0)) value.clear();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('Files drawer', () => {
  it('shows loading and request errors, not a false empty workspace, and retries', async () => {
    const listing = Promise.withResolvers<FileListing>();
    const list = vi.spyOn(getBotClient(), 'listFiles').mockReturnValueOnce(listing.promise);
    const screen = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(screen.queryByText('This workspace is empty.')).toBeNull();
    await act(async () => { listing.reject(new Error('directory offline')); });
    expect((await screen.findByRole('alert')).textContent).toContain('directory offline');
    expect(screen.queryByText('This workspace is empty.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => { expect(screen.getByText('/actual-thread')).toBeTruthy(); });
    expect(list).toHaveBeenCalledWith(bot.id, undefined, 'thread_a');
    expect(screen.queryByText(bot.workspace)).toBeNull();
  });

  it('enters directories, returns through breadcrumbs, retains metadata and reloads the open preview', async () => {
    vi.spyOn(getBotClient(), 'listFiles').mockImplementation(async (_id, path) => ({
      path: path ?? '/actual-thread', entries: path === '/actual-thread/src'
        ? [{ path: '/actual-thread/src/readme.md', kind: 'file', size: 500000 }]
        : [{ path: '/actual-thread/src', kind: 'directory', size: null }],
    }));
    const preview = vi.spyOn(getBotClient(), 'readFile').mockResolvedValue({ path: '/actual-thread/src/readme.md', content: 'beginning only', truncated: true });
    const screen = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    fireEvent.click(await screen.findByRole('button', { name: 'src' }));
    await screen.findByText('/actual-thread/src');
    expect(screen.getByRole('button', { name: 'Parent directory' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'readme.md 500000 B' }));
    expect(await screen.findByText('beginning only')).toBeTruthy();
    expect(screen.getByText('Preview truncated. Only the beginning of this file is shown.')).toBeTruthy();
    expect(preview).toHaveBeenLastCalledWith(bot.id, '/actual-thread/src/readme.md', 'thread_a');
    preview.mockResolvedValue({ path: '/actual-thread/src/readme.md', content: 'updated preview', truncated: false });
    await act(async () => { await screen.cache.invalidateQueries({ queryKey: ['file', bot.id] }); });
    expect(await screen.findByText('updated preview')).toBeTruthy();
    expect(screen.queryByText('Preview truncated. Only the beginning of this file is shown.')).toBeNull();
    preview.mockResolvedValue({ path: '/actual-thread/src/readme.md', content: 'manually refreshed', truncated: false });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('manually refreshed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Workspace root' }));
    await screen.findByText('/actual-thread');
    expect(screen.queryByRole('button', { name: 'Parent directory' })).toBeNull();
    expect(screen.queryByText('manually refreshed')).toBeNull();
  });

  it('keeps a failed file path visible, retries reads, and resets navigation when the thread changes', async () => {
    vi.spyOn(getBotClient(), 'listFiles').mockImplementation(async (_id, _path, thread) => ({ path: thread === 'thread_b' ? '/second-thread' : '/actual-thread', entries: [{ path: '/actual-thread/a.txt', kind: 'file', size: 3 }] }));
    const pending = Promise.withResolvers<FilePreview>();
    const read = vi.spyOn(getBotClient(), 'readFile').mockReturnValueOnce(pending.promise).mockResolvedValue({ path: '/actual-thread/a.txt', content: 'abc', truncated: false });
    const screen = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    fireEvent.click(await screen.findByRole('button', { name: 'a.txt 3 B' }));
    expect(screen.getByRole('status').textContent).toContain('Loading');
    await act(async () => { pending.reject(new Error('read denied')); });
    expect((await screen.findByRole('alert')).textContent).toContain('read denied');
    expect(screen.getByText('/actual-thread/a.txt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('abc')).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
    screen.switchThread('thread_b');
    expect(await screen.findByText('/second-thread')).toBeTruthy();
    expect(screen.queryByText('abc')).toBeNull();
    screen.switchThread(undefined);
    await waitFor(() => { expect(getBotClient().listFiles).toHaveBeenCalledWith(bot.id, undefined, undefined); });
  });
});

describe('Activity and Approvals drawers', () => {
  it('links to the actual thread, deduplicates exact run IDs and displays interrupted errors/unknown time', async () => {
    const run: Run = { id: 'run_a', botId: bot.id, threadId: 'thread_source', status: 'interrupted', startedAt: 0, endedAt: null, error: 'execution outcome unknown' };
    vi.spyOn(getBotClient(), 'listRuns').mockResolvedValue([run]);
    vi.spyOn(getBotClient(), 'listActivity').mockResolvedValue([{ id: 1, actor: bot.id, initiator: 'system', botId: bot.id, threadId: run.threadId, createdAt: 0, action: 'run.interrupted', decision: 'interrupted', payload: { runId: run.id, roomId: 'room_source' } }]);
    const screen = mountRouter(<RightDrawer bot={bot} />);
    expect(await screen.findByText('execution outcome unknown')).toBeTruthy();
    expect(screen.getByText('Unknown time')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Reader · Conversation thread_source' }).getAttribute('href')).toBe('/bots/reader/threads/thread_source');
    expect(screen.getByText('Run run_a · interrupted')).toBeTruthy();
    expect(screen.getByRole('link', { name: '#room_source' }).getAttribute('href')).toBe('/rooms/room_source');
  });

  it('does not report no activity when either activity request fails and recovers via Retry', async () => {
    const activity = vi.spyOn(getBotClient(), 'listActivity').mockRejectedValueOnce(new Error('audit offline')).mockResolvedValue([]);
    const screen = mount();
    expect((await screen.findByRole('alert')).textContent).toContain('audit offline');
    expect(screen.queryByText('Nothing has happened in this Bot yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull(); });
    expect(activity).toHaveBeenCalledTimes(2);
  });

  it('does not confuse pending/error approvals with nothing waiting, and ignores terminal items', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<ReturnType<typeof getBotClient>['listInbox']>>>();
    const inbox = vi.spyOn(getBotClient(), 'listInbox').mockReturnValueOnce(pending.promise).mockResolvedValue({ approvals: [], questions: [{ id: 'answered', botId: bot.id, threadId: 'old', runId: null, items: [], status: 'answered', createdAt: 1 }], handoffs: [] });
    const screen = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Approvals' }));
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(screen.queryByText('Reader is not waiting on you.')).toBeNull();
    await act(async () => { pending.reject(new Error('inbox offline')); });
    expect((await screen.findByRole('alert')).textContent).toContain('inbox offline');
    expect(screen.queryByText('Reader is not waiting on you.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Reader is not waiting on you.')).toBeTruthy();
    expect(inbox).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Approvals' }).textContent).toBe('Approvals');
  });
});

describe('navigation palette', () => {
  it('does not execute a navigation command while confirming an IME candidate', async () => {
    const closed = vi.fn();
    const screen = mountRouter(<CommandPalette open onOpenChange={closed} />);
    const search = await screen.findByRole('combobox');
    await screen.findByRole('option', { name: /Open Reader/ });
    fireEvent.change(search, { target: { value: 'Reader' } });
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true });
    expect(screen.router.state.location.pathname).toBe('/');
    expect(closed).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => { expect(screen.router.state.location.pathname).toBe('/bots/reader'); });
    expect(closed).toHaveBeenCalledWith(false);
  });

  it('keeps keyboard selection on the valid list after a Bot disappears', async () => {
    const screen = mountRouter(<CommandPalette open onOpenChange={() => undefined} />);
    const search = await screen.findByRole('combobox');
    await screen.findByRole('option', { name: /Open Reader/ });
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { selected: true }).textContent).toContain('Settings');
    await act(async () => { screen.cache.setQueryData(['bots'], []); });
    await waitFor(() => { expect(screen.queryByRole('option', { name: /Open Reader/ })).toBeNull(); });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { selected: true }).textContent).toContain('Inbox');
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => { expect(screen.router.state.location.pathname).toBe('/inbox'); });
  });

  it('shows failed navigation sources and retries rather than claiming no matches', async () => {
    const bots = vi.spyOn(getBotClient(), 'listBots').mockRejectedValueOnce(new Error('bots offline')).mockResolvedValue([bot]);
    const screen = mountRouter(<CommandPalette open onOpenChange={() => undefined} />);
    const search = await screen.findByRole('combobox');
    fireEvent.change(search, { target: { value: 'Reader' } });
    expect((await screen.findByRole('alert')).textContent).toContain('bots offline');
    expect(screen.queryByText('Nothing matches “Reader”.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: /Open Reader/ })).toBeTruthy();
    expect(bots).toHaveBeenCalledTimes(2);
  });

  it('searches the current Bot/room list and executes a real route', async () => {
    const closed = vi.fn();
    vi.spyOn(getBotClient(), 'listRooms').mockResolvedValue([{ id: 'room_a', name: 'Studio', memberIds: [bot.id], leadBotId: bot.id, createdAt: 1 }]);
    const screen = mountRouter(<CommandPalette open onOpenChange={closed} />);
    const search = await screen.findByRole('combobox');
    await screen.findByRole('option', { name: /Open Reader/ });
    fireEvent.change(search, { target: { value: 'studio' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Open #Studio/ })).toBeTruthy();
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => { expect(screen.router.state.location.pathname).toBe('/rooms/room_a'); });
    expect(closed).toHaveBeenCalledWith(false);
  });
});

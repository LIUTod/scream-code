// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Bot, Message, Run, ToolCall } from '../../../src/bot/shared/contracts';
import { getBotClient } from '../../../src/bot/ui/lib/api/client';
import { I18nProvider } from '../../../src/bot/ui/lib/i18n';
import { MessageBody } from '../../../src/bot/ui/components/chat/message-body';
import { ToolActivity } from '../../../src/bot/ui/components/chat/tool-activity';
import { Transcript } from '../../../src/bot/ui/components/chat/transcript';

const caches: QueryClient[] = [];
const resizeCallbacks: ResizeObserverCallback[] = [];
const current: Bot = {
  id: 'reading_bot', name: 'Reader', title: '', rolePrompt: '', avatarSeed: '', workspace: '/workspace',
  model: undefined, thinking: undefined, permission: 'bot', toolPolicy: {}, paused: false,
  status: 'working', unread: 0, needsYou: 0, lastActiveAt: null,
};
const message = (content: string, createdAt: number | null = null): Message => ({
  id: 'reply', threadId: 'thread_reading', role: 'assistant', content, createdAt,
});
const run = (threadId = 'thread_reading'): Run => ({ id: 'run_reading', botId: current.id, threadId, status: 'running', startedAt: 1, endedAt: null, error: null });
const tool = (id: string, output?: string): ToolCall => ({ id, name: `tool_${id}`, status: 'done', args: { path: '/workspace/file' }, output, startedAt: 1 });
function wrap(children: ReactNode) { return render(<I18nProvider>{children}</I18nProvider>); }
function transcript(items: Message[], runs: Run[] = []) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  caches.push(cache);
  cache.setQueryData(['messages', 'thread_reading'], items);
  cache.setQueryData(['runs', current.id], runs);
  cache.setQueryData(['inbox'], { approvals: [], questions: [], handoffs: [] });
  const screen = render(<QueryClientProvider client={cache}><I18nProvider><Transcript bot={current} threadId="thread_reading" /></I18nProvider></QueryClientProvider>);
  return { ...screen, cache };
}
beforeEach(() => {
  localStorage.setItem('scream.bot.lang', 'en');
  resizeCallbacks.length = 0;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
    observe() {} unobserve() {} disconnect() {}
  });
  vi.spyOn(getBotClient(), 'listMessages').mockResolvedValue([]);
  vi.spyOn(getBotClient(), 'listRuns').mockResolvedValue([]);
  vi.spyOn(getBotClient(), 'listInbox').mockResolvedValue({ approvals: [], questions: [], handoffs: [] });
});
afterEach(() => {
  cleanup();
  for (const cache of caches.splice(0)) cache.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('safe GFM transcript body', () => {
  it('renders real headings, lists, tables, links and code without injecting HTML', () => {
    const screen = wrap(<MessageBody content={'## Result\n\n- **done**\n- ~~old~~\n\n| Name | Value |\n| --- | --- |\n| row | `code` |\n\n[reference](https://example.test/docs)\n\n```ts\nconst answer = 42;\n```\n\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n![remote](https://tracker.test/pixel)'} />);
    expect(screen.getByRole('heading', { name: 'Result' })).toBeTruthy();
    expect(screen.getByRole('table').textContent).toContain('Name');
    expect(screen.container.querySelector('strong')?.textContent).toBe('done');
    expect(screen.container.querySelector('del')?.textContent).toBe('old');
    const link = screen.getByRole('link', { name: 'reference' });
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.container.querySelector('pre code')?.textContent).toBe('const answer = 42;');
    expect(screen.container.querySelector('script, iframe, img')).toBeNull();
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    expect(screen.container.textContent).toContain('<script>alert(1)</script>');
  });

  it.each(['javascript:alert(1)', 'java&#x73;cript:alert(1)', 'data:text/html,attack', 'file:///etc/passwd', '//tracker.test/x', 'https:\\evil.test'])('refuses unsafe link %s', (href) => {
    const screen = wrap(<MessageBody content={`[unsafe](<${href}>)`} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('copies exactly the code and makes clipboard failures visible', async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { language: 'en', clipboard: { writeText: copy } });
    const screen = wrap(<MessageBody content={'```sh\nprintf "<safe>"\n```'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy(); });
    expect(copy).toHaveBeenCalledWith('printf "<safe>"');
    copy.mockRejectedValue(new Error('clipboard denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBeTruthy(); });
  });
});

describe('tool and stream presentation', () => {
  it('folds adjacent tools and expands the complete long output only on request', () => {
    const long = `${'line\n'.repeat(30)}END-OF-OUTPUT`;
    const screen = wrap(<ToolActivity calls={[tool('one', long), tool('two')]} />);
    const details = screen.container.querySelector('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(screen.getByText('2 tools'));
    expect(details.open).toBe(true);
    fireEvent.click(screen.getByText('tool_one'));
    expect(screen.getByText('tool_one').closest('details')?.open).toBe(true);
    expect(screen.queryByText(/END-OF-OUTPUT/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByText(/END-OF-OUTPUT/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.queryByText(/END-OF-OUTPUT/)).toBeNull();
  });

  it('shows an empty streaming wait from this thread, without synthetic reasoning or duplicate avatars', () => {
    const screen = transcript([message('')], [run()]);
    expect(screen.getByLabelText('Working')).toBeTruthy();
    expect(screen.container.querySelectorAll('[data-slot="message-scroller-item"]')).toHaveLength(1);
    expect(screen.queryByText('Start with Reader')).toBeNull();
  });

  it('does not show another thread\'s wait from the aggregate Bot status', () => {
    const screen = transcript([message('an earlier answer')], [run('different_thread')]);
    expect(screen.queryByLabelText('Working')).toBeNull();
  });

  it('hides unknown clocks and shows known clocks without inventing timestamps', () => {
    const screen = transcript([message('historic', null), { ...message('known', 1_700_000_000_000), id: 'known' }]);
    expect(screen.container.querySelectorAll('time')).toHaveLength(1);
  });

  it('leaves a scrolled-up viewport in place on streamed growth and offers jump-to-end', () => {
    const screen = transcript([message('first')]);
    const viewport = screen.container.querySelector('[data-slot="message-scroller-viewport"]') as HTMLDivElement;
    Object.defineProperties(viewport, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 200, configurable: true } });
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    act(() => {
      screen.cache.setQueryData(['messages', 'thread_reading'], [message('first with a new streamed chunk')]);
      for (const notify of resizeCallbacks) notify([], {} as ResizeObserver);
    });
    expect(viewport.scrollTop).toBe(100);
    expect(screen.getByRole('button', { name: 'Scroll to end' }).dataset['active']).toBe('true');
    const scroll = vi.fn();
    viewport.scrollTo = scroll;
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to end' }));
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', top: 1000 });
  });

  it('shows transcript fetch errors instead of claiming the conversation is empty', async () => {
    const screen = transcript([]);
    vi.mocked(getBotClient().listMessages).mockRejectedValue(new Error('transcript offline'));
    await act(async () => { await screen.cache.refetchQueries({ queryKey: ['messages', 'thread_reading'] }); });
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('transcript offline'); });
    expect(screen.queryByText('Start with Reader')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

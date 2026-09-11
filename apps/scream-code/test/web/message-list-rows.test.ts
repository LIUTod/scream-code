// @vitest-environment jsdom
import { nextTick, reactive } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';

import MessageList from '../../src/web/frontend/src/components/MessageList.vue';
import MessageItem from '../../src/web/frontend/src/components/MessageItem.vue';

// Same jsdom shims as the D1 scroll/dividers suites: MessageList probes both.
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  void Promise.resolve().then(() => cb(Date.now()));
  return 0;
});
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
}));
// jsdom does not implement Element.scrollTo/scrollIntoView; MessageList's
// tail-follow auto-scroll (busy=true path) calls el.scrollTo inside an rAF
// callback and a late timer can land it after teardown → CI-visible
// unhandled rejection.
Element.prototype.scrollTo = () => {};
Element.prototype.scrollIntoView = () => {};

const DAY = 24 * 60 * 60 * 1000;
const GAP = 5 * 60 * 1000;
// 2026-09-02 09:00 local.
const T0 = new Date(2026, 8, 2, 9, 0).getTime();

function msg(id: string, role: 'user' | 'assistant', ts?: number) {
  return { id, role, content: 'x', ts, tools: [] };
}

interface ExtractedFlags {
  streaming: boolean;
  isLatestUser: boolean;
  canFork: boolean;
  showTimestamp: boolean;
  idle: boolean;
}

type ExtractedRow =
  | { kind: 'day-divider'; dividerText: string }
  | { kind: 'turn-divider' }
  | { kind: 'message'; id: string; flags: ExtractedFlags };

/**
 * Reconstruct the row model from the rendered DOM: walk `.message-list`
 * children in order (day pill / turn hairline / message article) and zip the
 * message articles with the mounted MessageItem components to read their
 * props. This is exactly what the template renders from `visibleRows`.
 */
function extractRows(wrapper: VueWrapper): ExtractedRow[] {
  const listEl = wrapper.find('.message-list').element as HTMLElement;
  const items = wrapper.findAllComponents(MessageItem);
  const rows: ExtractedRow[] = [];
  let i = 0;
  for (const el of Array.from(listEl.children)) {
    if (el.classList.contains('day-divider')) {
      rows.push({ kind: 'day-divider', dividerText: el.textContent ?? '' });
    } else if (el.classList.contains('turn-divider')) {
      rows.push({ kind: 'turn-divider' });
    } else if (Object.hasOwn(el.dataset, "messageId")) {
      const p = items[i++]!.props();
      rows.push({
        kind: 'message',
        id: (p.message as { id: string }).id,
        flags: {
          streaming: Boolean(p.streaming),
          isLatestUser: Boolean(p.isLatestUser),
          canFork: Boolean(p.canFork),
          showTimestamp: Boolean(p.showTimestamp),
          idle: Boolean(p.idle),
        },
      });
    }
  }
  return rows;
}

function messageRows(rows: ExtractedRow[]): Array<Extract<ExtractedRow, { kind: 'message' }>> {
  return rows.filter((r): r is Extract<ExtractedRow, { kind: 'message' }> => r.kind === 'message');
}

function flagsById(rows: ExtractedRow[], id: string): ExtractedFlags {
  const row = rows.find((r) => r.kind === 'message' && r.id === id);
  if (!row || row.kind !== 'message') throw new Error(`message row ${id} not found`);
  return row.flags;
}

describe('MessageList row model', () => {
  describe('divider boundary rows', () => {
    it('emits a turn hairline row before every user message except the first', () => {
      const wrapper = mount(MessageList, {
        props: {
          messages: [msg('u1', 'user', T0), msg('a1', 'assistant', T0 + 60_000), msg('u2', 'user', T0 + 120_000)],
          sessionId: 's-rows',
        },
      });
      expect(extractRows(wrapper).map((r) => r.kind)).toEqual([
        'message',
        'message',
        'turn-divider',
        'message',
      ]);
    });

    it('emits a day-divider row (with the same pill text) instead of the hairline when crossing local midnight', () => {
      const wrapper = mount(MessageList, {
        props: {
          messages: [msg('u1', 'user', T0), msg('a2', 'user', T0 + DAY)],
          sessionId: 's-rows',
        },
      });
      const rows = extractRows(wrapper);
      expect(rows.map((r) => r.kind)).toEqual(['message', 'day-divider', 'message']);
      expect(rows[1]).toEqual({ kind: 'day-divider', dividerText: '9月3日' });
    });

    it('skips the day-divider row when a neighbor has no timestamp, keeping the hairline', () => {
      const wrapper = mount(MessageList, {
        props: { messages: [msg('u1', 'user'), msg('u2', 'user', T0)], sessionId: 's-rows' },
      });
      expect(extractRows(wrapper).map((r) => r.kind)).toEqual(['message', 'turn-divider', 'message']);
    });
  });

  describe('timestamp throttling (showTimestamp flag)', () => {
    it('shows the timestamp only on the last message of a run of consecutive assistant messages', () => {
      const wrapper = mount(MessageList, {
        props: {
          messages: [msg('a1', 'assistant', T0), msg('a2', 'assistant', T0 + 60_000), msg('a3', 'assistant', T0 + 120_000)],
          sessionId: 's-rows',
        },
      });
      const rows = extractRows(wrapper);
      expect(flagsById(rows, 'a1').showTimestamp).toBe(false);
      expect(flagsById(rows, 'a2').showTimestamp).toBe(false);
      expect(flagsById(rows, 'a3').showTimestamp).toBe(true);
    });

    it('forces the timestamp back on after a >5min gap inside an assistant run', () => {
      const wrapper = mount(MessageList, {
        props: {
          messages: [msg('a1', 'assistant', T0), msg('a2', 'assistant', T0 + GAP + 1)],
          sessionId: 's-rows',
        },
      });
      const rows = extractRows(wrapper);
      expect(flagsById(rows, 'a1').showTimestamp).toBe(true);
      expect(flagsById(rows, 'a2').showTimestamp).toBe(true);
    });

    it('user messages always show their timestamp, breaking the assistant run on both sides', () => {
      const wrapper = mount(MessageList, {
        props: {
          messages: [msg('a1', 'assistant', T0), msg('u1', 'user', T0 + 60_000), msg('a2', 'assistant', T0 + 120_000)],
          sessionId: 's-rows',
        },
      });
      const rows = extractRows(wrapper);
      expect(flagsById(rows, 'a1').showTimestamp).toBe(true);
      expect(flagsById(rows, 'u1').showTimestamp).toBe(true);
      expect(flagsById(rows, 'a2').showTimestamp).toBe(true);
    });
  });

  describe('streaming / latest-user / fork flags', () => {
    it('marks only the LAST assistant message as streaming while busy', () => {
      const wrapper = mount(MessageList, {
        props: {
          messages: [msg('u1', 'user', T0), msg('a1', 'assistant', T0 + 60_000), msg('a2', 'assistant', T0 + 120_000)],
          busy: true,
          sessionId: 's-rows',
        },
      });
      const rows = extractRows(wrapper);
      expect(flagsById(rows, 'u1').streaming).toBe(false);
      expect(flagsById(rows, 'a1').streaming).toBe(false);
      expect(flagsById(rows, 'a2').streaming).toBe(true);
    });

    it('marks nothing as streaming when idle, even for the last assistant message', () => {
      const wrapper = mount(MessageList, {
        props: { messages: [msg('a2', 'assistant', T0)], busy: false, sessionId: 's-rows' },
      });
      expect(flagsById(extractRows(wrapper), 'a2').streaming).toBe(false);
    });

    it('keeps isLatestUser unique — only the last user message carries it, even when assistant messages follow', () => {
      const wrapper = mount(MessageList, {
        props: {
          messages: [msg('u1', 'user', T0), msg('a1', 'assistant', T0 + 60_000), msg('u2', 'user', T0 + 120_000), msg('a2', 'assistant', T0 + 180_000)],
          sessionId: 's-rows',
        },
      });
      const rows = extractRows(wrapper);
      const latestUsers = messageRows(rows).filter((r) => r.flags.isLatestUser);
      expect(latestUsers.map((r) => r.id)).toEqual(['u2']);
    });

    it('offers canFork only on the last assistant message while idle, and idle mirrors !busy on every row', () => {
      const idleWrapper = mount(MessageList, {
        props: {
          messages: [msg('u1', 'user', T0), msg('a1', 'assistant', T0 + 60_000), msg('a2', 'assistant', T0 + 120_000)],
          sessionId: 's-rows',
        },
      });
      const idleRows = extractRows(idleWrapper);
      expect(flagsById(idleRows, 'a1').canFork).toBe(false);
      expect(flagsById(idleRows, 'a2').canFork).toBe(true);
      for (const r of messageRows(idleRows)) expect(r.flags.idle).toBe(true);

      const busyWrapper = mount(MessageList, {
        props: {
          messages: [msg('u1', 'user', T0), msg('a1', 'assistant', T0 + 60_000), msg('a2', 'assistant', T0 + 120_000)],
          busy: true,
          sessionId: 's-rows',
        },
      });
      const busyRows = extractRows(busyWrapper);
      for (const r of messageRows(busyRows)) expect(r.flags.idle).toBe(false);
      expect(flagsById(busyRows, 'a2').canFork).toBe(false);
    });
  });

  describe('rows are pure derivations', () => {
    it('two mounts with the same messages input produce deeply equal row models', () => {
      const build = () => [
        msg('u1', 'user', T0),
        msg('a1', 'assistant', T0 + 60_000),
        msg('u2', 'user', T0 + DAY),
        msg('a2', 'assistant', T0 + DAY + 60_000),
      ];
      const first = extractRows(mount(MessageList, { props: { messages: build(), sessionId: 's-rows' } }));
      const second = extractRows(mount(MessageList, { props: { messages: build(), sessionId: 's-rows' } }));
      expect(second).toEqual(first);
    });
  });

  describe('streaming content under the v-memo freeze', () => {
    // Drain vue ticks + the stubbed rAF microtasks + the renderer's coalesce timer.
    async function flush() {
      for (let i = 0; i < 4; i++) {
        await nextTick();
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    it('live-updates the streaming assistant row (memo must not freeze the active row)', async () => {
      // reactive() mirrors the app: the WS path mutates through the ref's
      // proxy; mutating raw objects would bypass change tracking entirely.
      const messages = reactive([msg('u1', 'user', T0), msg('a1', 'assistant', T0 + 60_000)]);
      const wrapper = mount(MessageList, { props: { messages, sessionId: 's-stream', busy: true } });
      expect(flagsById(extractRows(wrapper), 'a1').streaming).toBe(true);

      // In-place content growth — exactly what the WS delta path does per frame.
      messages[1].content += ' LIVE-TAIL-9';
      await flush();

      expect(wrapper.text()).toContain('LIVE-TAIL-9');
    });

    it('re-flags the row when busy flips off (streaming end unfreezes memo)', async () => {
      const messages = [msg('u1', 'user', T0), msg('a1', 'assistant', T0 + 60_000)];
      const wrapper = mount(MessageList, { props: { messages, sessionId: 's-stream2', busy: true } });
      expect(flagsById(extractRows(wrapper), 'a1').streaming).toBe(true);

      await wrapper.setProps({ busy: false });

      const flags = flagsById(extractRows(wrapper), 'a1');
      expect(flags.streaming).toBe(false);
      expect(flags.canFork).toBe(true);
    });
  });
});

// @vitest-environment jsdom
/**
 * Lazy session creation + new-session confirmation dialog:
 * 1. The "new chat" entry point opens NewSessionModal right away (pick workdir /
 *    model) with zero createSession calls; only confirming creates exactly one
 *    session and moves to the chat view, while cancelling creates nothing and
 *    leaves the view untouched;
 * 2. Sending from home always creates a session (home = the new-conversation entry
 *    point) - the binding is deliberately kept (WS firstActive fallback), and
 *    creating only when there is no binding would make "back to new chat -> send"
 *    pour the message silently into the old session;
 * 3. Sending from the conversation page after explicitly opening an existing
 *    session reuses that session (the conversation Composer does not create);
 * 4. A skill "try it" with no session lands in the WorkspaceHome input on the home
 *    page; with a session it goes through the conversation page;
 * 5. MessageList with an empty journal no longer renders the old onboarding hero
 *    (that component is retired); the skeleton only belongs to the in-flight send
 *    state;
 * 6. Home sends carry an in-flight guard: double clicks / a second Enter let only
 *    one "create session + first message" through;
 * 7. Clicking "new chat" while the settings modal is open closes settings first, so
 *    the two modals never stack.
 *
 * The mount shape follows dock-tabs.test.ts (WebShell + module mocks); the
 * difference is that this suite renders WorkspaceHome/Composer for real so it can
 * assert the input content directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const shared = vi.hoisted(() => ({ client: null as Record<string, unknown> | null }));

vi.mock('../../src/web/frontend/src/composables/useScreamWebClient', async () => {
  const { ref } = await import('vue');
  const currentSessionId = ref<string | null>('old-1');
  const sessionId = ref<string | null>('old-1');
  const sessions = ref([{ sessionId: 'old-1', title: '旧会话', updatedAt: 0 }]);
  // Each creation gets an increasing id, which supports the multi-send assertions
  // of the "sending from home always creates" contract.
  let createSeq = 0;
  shared.client = {
    connectionStatus: ref('connected'),
    status: ref({ busy: false, model: 'test-model', connectionStatus: 'connected' }),
    isBusy: ref(false),
    sessions,
    currentSessionId,
    sessionId,
    workDir: ref('/tmp/wd'),
    gitStatus: ref(null),
    models: ref([]),
    like: ref({}),
    isArchived: ref(false),
    goal: ref(null),
    todos: ref([]),
    goalRequestPending: ref(false),
    goalRequestError: ref(null),
    olderAvailable: ref(false),
    sendPrompt: vi.fn(),
    sendCommand: vi.fn(),
    appendSystemMessage: vi.fn(),
    // Mirrors what sessions.ts really does: create a session and move the current
    // binding to the new id.
    createSession: vi.fn(async () => {
      createSeq += 1;
      const id = `new-${createSeq}`;
      currentSessionId.value = id;
      sessionId.value = id;
      sessions.value = [{ sessionId: id, title: `新会话${createSeq}`, updatedAt: createSeq }, ...sessions.value];
    }),
    switchSession: vi.fn(async (id: string) => {
      currentSessionId.value = id;
      sessionId.value = id;
    }),
    deleteSession: vi.fn(),
    switchModel: vi.fn(),
    switchThinking: vi.fn(),
    clearMessages: vi.fn(),
    exportSession: vi.fn(),
    fetchSnapshot: vi.fn(async () => undefined),
    fetchLike: vi.fn(async () => undefined),
    fetchGitStatus: vi.fn(async () => undefined),
    fetchSessions: vi.fn(async () => undefined),
    fetchSessionUsage: vi.fn(async () => undefined),
    fetchSessionContext: vi.fn(async () => undefined),
    reconnectNow: vi.fn(),
    resolveApproval: vi.fn(),
    loadOlderMessages: vi.fn(async () => undefined),
    abort: vi.fn(),
    updateLike: vi.fn(async () => true),
    refineGoal: vi.fn(async () => null),
    createGoal: vi.fn(async () => true),
    updateGoal: vi.fn(async () => true),
    pauseGoal: vi.fn(async () => true),
    resumeGoal: vi.fn(async () => true),
    cancelGoal: vi.fn(async () => true),
    /** Fixture reset: createSeq lives in the mock factory closure, so cases must clear it through here. */
    __resetFixtures: () => {
      createSeq = 0;
    },
  };
  return { useScreamWebClient: () => shared.client };
});

/* Sidebar is replaced by a stand-in with buttons: DOM clicks drive create-session /
 * navigate / switch-session, and the events go through WebShell's real wiring. */
vi.mock('../../src/web/frontend/src/components/Sidebar.vue', async () => {
  const { h } = await import('vue');
  return {
    default: {
      name: 'SidebarStub',
      emits: ['create-session', 'navigate', 'switch-session'],
      render(this: { $emit: (e: string, ...a: unknown[]) => void }) {
        return h('div', { class: 'sidebar-stub' }, [
          h('button', { class: 'stub-new', onClick: () => this.$emit('create-session') }),
          h('button', { class: 'stub-nav-chat', onClick: () => this.$emit('navigate', 'chat') }),
          h('button', { class: 'stub-nav-home', onClick: () => this.$emit('navigate', 'home') }),
          h('button', { class: 'stub-nav-skills', onClick: () => this.$emit('navigate', 'skills') }),
          h('button', { class: 'stub-switch-old', onClick: () => this.$emit('switch-session', 'old-1') }),
        ]);
      },
    },
  };
});

/* Conversation page stand-in: records host injection calls (the chat route's
 * "try it" main path is still verified through it). */
vi.mock('../../src/web/frontend/src/components/ConversationView.vue', async () => {
  const { h } = await import('vue');
  const insertDraft = vi.fn(() => true);
  (globalThis as { __conversationInsertDraft?: Mock }).__conversationInsertDraft = insertDraft;
  return {
    default: {
      name: 'ConversationViewStub',
      setup(_props: unknown, { expose }: { expose: (v: Record<string, unknown>) => void }) {
        expose({ insertDraft });
        return () => h('div', { class: 'conversation-stub' });
      },
    },
  };
});

/* Skills centre stand-in: "try it" calls the inject-draft the host passed in (the
 * real SkillsView onTry main path is exactly that one call; the clipboard fallback
 * is covered by skill-try-composer.test). */
vi.mock('../../src/web/frontend/src/components/SkillsView.vue', async () => {
  const { h } = await import('vue');
  return {
    default: {
      name: 'SkillsViewStub',
      props: { injectDraft: { type: Function, default: undefined }, create: { type: Function, default: undefined } },
      render(this: { $props: { injectDraft?: (t: string) => boolean | Promise<boolean> } }) {
        return h('div', { class: 'skills-stub' }, [
          h('button', { class: 'stub-try', onClick: () => void this.$props.injectDraft?.('/demo ') }),
        ]);
      },
    },
  };
});

vi.mock('../../src/web/frontend/src/components/SettingsView.vue', async () => {
  const { h } = await import('vue');
  return { default: { name: 'SettingsViewStub', render: () => h('div', { class: 'settings-stub' }) } };
});
vi.mock('../../src/web/frontend/src/components/InfoPanel.vue', async () => {
  const { h } = await import('vue');
  return { default: { name: 'InfoPanelStub', render: () => h('div', { class: 'info-stub' }) } };
});
vi.mock('../../src/web/frontend/src/components/FileViewer.vue', async () => {
  const { h } = await import('vue');
  return { default: { name: 'FileViewerStub', render: () => h('div', { class: 'file-viewer-stub' }) } };
});

import WebShell from '../../src/web/frontend/src/components/WebShell.vue';
import WorkspaceHome from '../../src/web/frontend/src/components/WorkspaceHome.vue';
import NewSessionModal from '../../src/web/frontend/src/components/NewSessionModal.vue';
import MessageList from '../../src/web/frontend/src/components/MessageList.vue';
import { useScreamWebClient } from '../../src/web/frontend/src/composables/useScreamWebClient';
import { setPreferredWorkDir } from '../../src/web/frontend/src/composables/useWorkspacePreference';
import { useSettingsModal } from '../../src/web/frontend/src/composables/useSettingsModal';

/* jsdom shims: both are probed by MessageList/Composer; same shape as message-list-rows. */
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
Element.prototype.scrollTo = () => {};
Element.prototype.scrollIntoView = () => {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function client(): any {
  return useScreamWebClient();
}

const hosts: HTMLElement[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountShell(): any {
  const host = document.createElement('div');
  document.body.append(host);
  const wrapper = mount(WebShell, { attachTo: host });
  hosts.push(host);
  return wrapper;
}

function clickStub(wrapper: { find(selector: string): { trigger(e: string): Promise<void> } }, cls: string) {
  return wrapper.find(`.${cls}`).trigger('click');
}

beforeEach(() => {
  localStorage.clear();
  const c = client();
  c.currentSessionId.value = 'old-1';
  c.sessionId.value = 'old-1';
  c.sessions.value = [{ sessionId: 'old-1', title: '旧会话', updatedAt: 0 }];
  c.createSession.mockClear();
  c.switchSession.mockClear();
  c.sendPrompt.mockClear();
  c.sendCommand.mockClear();
  (c as unknown as { __resetFixtures?: () => void }).__resetFixtures?.();
  (globalThis as { __conversationInsertDraft?: Mock }).__conversationInsertDraft?.mockClear();
});

afterEach(() => {
  while (hosts.length > 0) hosts.pop()!.remove();
});

describe('lazy session creation (WebShell wiring)', () => {
  it('clicking "new chat" opens the confirm dialog: zero createSession; confirming creates exactly one and enters chat', async () => {
    const wrapper = mountShell();
    await flushPromises();
    // First really enter an existing session to confirm the chat view is present.
    await clickStub(wrapper, 'stub-nav-chat');
    expect(wrapper.find('.conversation-stub').exists()).toBe(true);

    await clickStub(wrapper, 'stub-new');
    await flushPromises();
    // New contract: the entry point is the dialog itself - the new-session modal
    // shows up while neither the view nor the binding moves, with zero session
    // creation.
    const modal = wrapper.findComponent(NewSessionModal);
    expect(modal.exists()).toBe(true);
    expect(modal.props('open')).toBe(true);
    expect(wrapper.find('.conversation-stub').exists()).toBe(true);
    expect(client().currentSessionId.value).toBe('old-1');
    expect(client().createSession).not.toHaveBeenCalled();

    // Cancel: the dialog closes and no session is created.
    modal.vm.$emit('close');
    await flushPromises();
    expect(wrapper.findComponent(NewSessionModal).props('open')).toBe(false);
    expect(client().createSession).not.toHaveBeenCalled();

    // Reopen and confirm: exactly one createSession, then the chat view.
    await clickStub(wrapper, 'stub-new');
    await flushPromises();
    wrapper.findComponent(NewSessionModal).vm.$emit('confirm', { workDir: null, model: null });
    await flushPromises();
    expect(client().createSession).toHaveBeenCalledTimes(1);
    expect(client().currentSessionId.value).toBe('new-1');
    expect(wrapper.find('.conversation-stub').exists()).toBe(true);
  });

  it('send from home with no session bound at all: createSession runs exactly once and the send happens after the new binding', async () => {
    const wrapper = mountShell();
    await flushPromises();
    const c = client();
    let boundAtSend: string | null = null;
    c.sendPrompt.mockImplementation(() => {
      boundAtSend = c.currentSessionId.value;
    });

    // Cold start / every session deleted: nothing is bound.
    c.currentSessionId.value = null;
    await clickStub(wrapper, 'stub-nav-home');
    await flushPromises();
    wrapper.findComponent(WorkspaceHome).vm.$emit('send', '你好，新世界', 'chat');
    await flushPromises();

    expect(c.createSession).toHaveBeenCalledTimes(1);
    expect(c.sendPrompt).toHaveBeenCalledTimes(1);
    // Key assertion: the binding at send time is already the new session, not the
    // old-1 left over from the WS.
    expect(boundAtSend).toBe('new-1');
    // The chat view opens once the connection is ready.
    expect(wrapper.find('.conversation-stub').exists()).toBe(true);
    // New contract: explicitly going back home and sending = another new
    // conversation, which must create yet another one - even when the binding is
    // already new-1, a home send never reuses the old binding (this is the fix for
    // "message lands in the old session").
    await clickStub(wrapper, 'stub-nav-home');
    wrapper.findComponent(WorkspaceHome).vm.$emit('send', '另起一条', 'chat');
    await flushPromises();
    expect(c.createSession).toHaveBeenCalledTimes(2);
    expect(c.sendPrompt).toHaveBeenCalledTimes(2);
    expect(boundAtSend).toBe('new-2');
  });

  it('the home stop button must be reachable: abort is forwarded from WorkspaceHome to client.abort', async () => {
    // Home also gets a "turn running" state (a session created after consuming a
    // draft, or waiting for the first frame) and the primary button is a stop button
    // then - WorkspaceHome used to bind @send but not @abort, so the button looked
    // right yet did nothing when clicked.
    const wrapper = mountShell();
    await flushPromises();
    const c = client();
    wrapper.findComponent(WorkspaceHome).vm.$emit('abort');
    await flushPromises();
    expect(c.abort).toHaveBeenCalledTimes(1);
  });

  it('send from home after binding an old session: still creates a session (home = new conversation entry), the send lands on the new binding', async () => {
    const wrapper = mountShell();
    await flushPromises();
    const c = client();

    // Simulate the client switching its binding to the old session (the mock
    // switchSession does not touch the ref itself, so sync it by hand).
    c.switchSession.mockImplementation((id: string) => {
      c.currentSessionId.value = id;
    });
    await clickStub(wrapper, 'stub-switch-old');
    await flushPromises();
    expect(c.switchSession).toHaveBeenCalledWith('old-1');

    // Click "back to new chat" to reach home - the binding is deliberately kept (see
    // the WS firstActive note), but sending from here must open a new session and
    // never pour into old-1.
    await clickStub(wrapper, 'stub-nav-home');
    await flushPromises();
    wrapper.findComponent(WorkspaceHome).vm.$emit('send', '开一条全新的', 'chat');
    await flushPromises();
    expect(c.createSession).toHaveBeenCalledTimes(1);
    expect(c.sendPrompt).toHaveBeenCalledTimes(1);
    expect(c.currentSessionId.value).toBe('new-1');
  });

  it('skill "try it": lands in the home input with no session bound; with a session it goes through the conversation page', async () => {
    const wrapper = mountShell();
    await flushPromises();
    const c = client();

    // Scenario A: trying it with no bound session -> the home Composer input.
    c.currentSessionId.value = null;
    await clickStub(wrapper, 'stub-nav-skills');
    // Persisting the draft is debounced by 300ms. Only setTimeout/clearTimeout are
    // faked here: setImmediate stays real so flushPromises keeps working, and Date
    // stays real so the TTL check for injected drafts is unaffected. Advancing the
    // fake clock to the deadline is enough - never really sleep 360ms (a real sleep
    // observing the debounce flakes under CI load, and the contract itself has
    // nothing to do with wall-clock time).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await clickStub(wrapper, 'stub-try');
      await flushPromises();
      await flushPromises();
      expect(wrapper.findComponent(WorkspaceHome).exists()).toBe(true);
      const input = wrapper.find('.composer-input').element as HTMLTextAreaElement;
      expect(input.value).toBe('/demo ');
      expect(c.createSession).not.toHaveBeenCalled();
      // Before committing, the draft follows home's persistence key (written to disk
      // once the debounce fires).
      await vi.advanceTimersByTimeAsync(360);
      expect(localStorage.getItem('scream-draft:default')).toBe('/demo ');
    } finally {
      vi.useRealTimers();
    }
    // Navigate away and back: the draft is still there (unmounting home does not
    // lose an unsent draft).
    await clickStub(wrapper, 'stub-nav-skills');
    await flushPromises();
    await clickStub(wrapper, 'stub-nav-home');
    await flushPromises();
    const input2 = wrapper.find('.composer-input').element as HTMLTextAreaElement;
    expect(input2.value).toBe('/demo ');

    // Scenario B: with a bound session -> the conversation page input (the
    // ConversationView forwarding point). Note the mock client is a module-level
    // shared object and scenario A set it to null, so restore the binding explicitly.
    client().currentSessionId.value = 'old-1';
    const wrapper2 = mountShell();
    await flushPromises();
    await clickStub(wrapper2, 'stub-nav-skills');
    await clickStub(wrapper2, 'stub-try');
    await flushPromises();
    await flushPromises();
    expect(wrapper2.find('.conversation-stub').exists()).toBe(true);
    const convInsert = (globalThis as { __conversationInsertDraft?: Mock }).__conversationInsertDraft;
    expect(convInsert).toHaveBeenCalled();
    expect(convInsert!.mock.calls[0]![0]).toBe('/demo ');
    expect(wrapper2.findComponent(WorkspaceHome).exists()).toBe(false);
  });
});

describe('workspace selection -> createSession payload (WebShell wiring)', () => {
  it('a home send carries the selected workDir', async () => {
    setPreferredWorkDir(null);
    setPreferredWorkDir('/picked/dir');
    const wrapper = mountShell();
    await flushPromises();
    const c = client();

    // Creation is only reached when nothing is bound, and it carries the selected workDir.
    c.currentSessionId.value = null;
    await clickStub(wrapper, 'stub-nav-home');
    await flushPromises();
    wrapper.findComponent(WorkspaceHome).vm.$emit('send', '你好', 'chat');
    await flushPromises();

    expect(c.createSession).toHaveBeenCalledTimes(1);
    expect(c.createSession).toHaveBeenCalledWith('/picked/dir');
    // Session created successfully -> the send goes through and the input is not refilled.
    expect(c.sendPrompt).toHaveBeenCalledTimes(1);
    setPreferredWorkDir(null);
  });

  it('creation failure (for example an invalid directory): stay on home, refill the input, do not send', async () => {
    setPreferredWorkDir(null);
    const wrapper = mountShell();
    await flushPromises();
    const c = client();
    // Mimic how sessions.createSession looks after a failure: the toast lives in the
    // inner layer and the binding is unchanged.
    c.createSession.mockImplementationOnce(async () => undefined);

    // Creation is only reached when nothing is bound; on failure the send is dropped.
    c.currentSessionId.value = null;
    await clickStub(wrapper, 'stub-nav-home');
    await flushPromises();
    wrapper.findComponent(WorkspaceHome).vm.$emit('send', '先试一条', 'chat');
    await flushPromises();
    await flushPromises();

    // Send dropped: nothing was poured into any session and the view stays on home.
    expect(c.sendPrompt).not.toHaveBeenCalled();
    expect(wrapper.findComponent(WorkspaceHome).exists()).toBe(true);
    // L3 discipline: after a failure the input is refilled into the Composer so the
    // user does not have to retype it.
    const input = wrapper.find('.composer-input').element as HTMLTextAreaElement;
    expect(input.value).toBe('先试一条');
  });
});

describe('in-flight guard for home sends (double clicks do not create two sessions)', () => {
  it('two sends inside one in-flight window only let one through: one session created, the first message lands on the new binding', async () => {
    const wrapper = mountShell();
    await flushPromises();
    const c = client();
    c.currentSessionId.value = null;
    await clickStub(wrapper, 'stub-nav-home');
    await flushPromises();

    // Hold the first creation open to manufacture the in-flight window - a real
    // double click is exactly two emits with no await in between.
    const realCreate = c.createSession.getMockImplementation() as () => Promise<void>;
    let release: () => void = () => {};
    c.createSession.mockImplementationOnce(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      await realCreate();
    });

    const home = wrapper.findComponent(WorkspaceHome);
    home.vm.$emit('send', '第一条', 'chat');
    home.vm.$emit('send', '第二条', 'chat');
    await flushPromises();

    // Guard: the second one creates nothing and sends nothing, so no extra 0-message
    // junk session appears on screen.
    expect(c.createSession).toHaveBeenCalledTimes(1);
    expect(c.sendPrompt).not.toHaveBeenCalled();
    // The second one is not silently dropped (L3 discipline): it is refilled into the
    // home input and home stays on screen.
    const input = wrapper.find('.composer-input').element as HTMLTextAreaElement;
    expect(input.value).toBe('第二条');

    release();
    await flushPromises();
    expect(c.createSession).toHaveBeenCalledTimes(1);
    expect(c.sendPrompt).toHaveBeenCalledTimes(1);
    // The first message goes to the newly created binding and is not intercepted by
    // the session created afterwards.
    expect(c.sendPrompt).toHaveBeenCalledWith('第一条');
    expect(
      (c.sessions.value as { sessionId: string }[]).filter((s) => s.sessionId.startsWith('new-')),
    ).toHaveLength(1);
  });
});

describe('modal exclusion (settings vs new session)', () => {
  it('clicking "new chat" while the settings modal is open closes settings first and never stacks two modals', async () => {
    const wrapper = mountShell();
    await flushPromises();
    const { open: settingsOpen, openSettingsModal, closeSettingsModal } = useSettingsModal();
    openSettingsModal();
    expect(settingsOpen.value).toBe(true);

    await clickStub(wrapper, 'stub-new');
    await flushPromises();
    expect(wrapper.findComponent(NewSessionModal).props('open')).toBe(true);
    // A single Escape closes only one: the settings modal is already dismissed at the
    // new-session entry point.
    expect(settingsOpen.value).toBe(false);
    closeSettingsModal();
  });
});

describe('MessageList with an empty journal (the old onboarding hero is retired)', () => {
  it('with zero messages it no longer renders the onboarding hero, and no skeleton either', async () => {
    const wrapper = mount(MessageList, {
      props: { messages: [], connected: true },
      global: { stubs: { ChatMinimap: true, SvgIcon: true } },
    });
    expect(wrapper.find('.empty-state').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Scream Web UI');
    expect(wrapper.find('.message-skeleton').exists()).toBe(false);
  });

  it('send in flight (busy + last message from user) shows the skeleton only', async () => {
    const wrapper = mount(MessageList, {
      props: {
        messages: [{ id: 'u1', role: 'user', content: 'hi', ts: 0, tools: [] }],
        busy: true,
        connected: true,
      },
      global: { stubs: { ChatMinimap: true, SvgIcon: true } },
    });
    expect(wrapper.find('.message-skeleton').exists()).toBe(true);
    expect(wrapper.find('.empty-state').exists()).toBe(false);
  });
});

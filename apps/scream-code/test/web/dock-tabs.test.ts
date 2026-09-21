// @vitest-environment jsdom
/**
 * Dock integration tests mounted through WebShell: the registry tab strip
 * must mount a pane on selection and keep it mounted (v-show only) when
 * hidden; session-level kinds are singletons; the dock collapses/expands
 * through the store; the <1024 band forces the 56px rail via matchMedia;
 * the <768 band turns the dock into the full-screen overlay float.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const shared = vi.hoisted(() => ({ client: null as Record<string, unknown> | null }));

vi.mock('../../src/web/frontend/src/composables/useScreamWebClient', async () => {
  const { ref } = await import('vue');
  shared.client = {
    connectionStatus: ref('connected'),
    status: ref({ busy: false, model: 'test-model' }),
    isBusy: ref(false),
    sessions: ref([]),
    currentSessionId: ref('s-1'),
    sessionId: ref('s-1'),
    workDir: ref('/tmp/wd'),
    gitStatus: ref({ branch: 'main', changed: 0, files: [], ahead: 0, behind: 0 }),
    models: ref([]),
    like: ref({}),
    isArchived: ref(false),
    goal: ref(null),
    todos: ref([]),
    subagents: ref([]),
    goalRequestPending: ref(false),
    goalRequestError: ref(null),
    olderAvailable: ref(false),
    sendPrompt: vi.fn(),
    sendCommand: vi.fn(),
    appendSystemMessage: vi.fn(),
    createSession: vi.fn(async () => undefined),
    switchSession: vi.fn(),
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
    fetchSessionStatus: vi.fn(async () => undefined),
    fetchSessionPlan: vi.fn(async () => undefined),
    sessionPlan: ref(null),
    switchPlanMode: vi.fn(async () => true),
    switchWolfpack: vi.fn(async () => true),
    switchRlm: vi.fn(async () => true),
    clearPlan: vi.fn(async () => true),
    undoHistory: vi.fn(async () => true),
    compact: vi.fn(async () => true),
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
  };
  return { useScreamWebClient: () => shared.client };
});

/* Heavy siblings of the shell are irrelevant here — stub them so only the
 * dock column under test renders for real. */
vi.mock('../../src/web/frontend/src/components/ConversationView.vue', async () => {
  const { h } = await import('vue');
  return { default: { name: 'ConversationViewStub', render: () => h('div', { class: 'conversation-stub' }) } };
});
vi.mock('../../src/web/frontend/src/components/WorkspaceHome.vue', async () => {
  const { h } = await import('vue');
  return { default: { name: 'WorkspaceHomeStub', render: () => h('div', { class: 'home-stub' }) } };
});
vi.mock('../../src/web/frontend/src/components/SkillsView.vue', async () => {
  const { h } = await import('vue');
  return { default: { name: 'SkillsViewStub', render: () => h('div', { class: 'skills-stub' }) } };
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
vi.mock('../../src/web/frontend/src/components/Sidebar.vue', async () => {
  const { h } = await import('vue');
  return {
    default: {
      name: 'SidebarStub',
      props: { collapsed: { type: Boolean, default: false } },
      emits: ['toggle-collapse'],
      render(this: { collapsed: boolean; $emit: (e: string) => void }) {
        return h('div', { class: ['sidebar-stub', { collapsed: this.collapsed }] }, [
          h('button', { class: 'stub-rail-toggle', onClick: () => this.$emit('toggle-collapse') }),
        ]);
      },
    },
  };
});

import WebShell from '../../src/web/frontend/src/components/WebShell.vue';
import ConversationHeader from '../../src/web/frontend/src/components/ConversationHeader.vue';
import {
  closeDockTab,
  dockPanel,
  openDockTab,
  openFileInPanel,
  selectDockTab,
  setDockOpen,
} from '../../src/web/frontend/src/utils/fileTabState';

function resetDock(): void {
  dockPanel.tabs = [];
  dockPanel.activeTabId = null;
  dockPanel.panelOpen = false;
  localStorage.clear();
}

/** Media-query double: only the compact-nav query ever matches. */
function stubMatchMedia(compactMatches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: compactMatches && query.includes('1023px'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function spyInnerWidth(width: number): void {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width);
}

/** Attach to a live container so keep-alive can be asserted through
 *  document.contains (a detached VTU tree would always report false). */
function mountShell() {
  const host = document.createElement('div');
  document.body.append(host);
  const w = mount(WebShell, { attachTo: host });
  pendingHosts.push(host);
  return w;
}

const pendingHosts: HTMLElement[] = [];

// Loose typing on purpose: several different stubbed component trees share
// this handle across cases.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wrapper: any = null;

beforeEach(() => {
  resetDock();
  stubMatchMedia(false);
  spyInnerWidth(1440);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  while (pendingHosts.length > 0) pendingHosts.pop()!.remove();
  vi.restoreAllMocks();
});

describe('dock tab registry (mount / keep-alive)', () => {
  it('registers and mounts the session-controls dock pane', async () => {
    wrapper = mountShell();
    openDockTab('control');
    await flushPromises();
    const pane = wrapper.find('.dock-pane--control');
    expect(pane.exists()).toBe(true);
    expect(pane.find('.session-controls').exists()).toBe(true);
    expect(wrapper.find('.tab-button[data-kind="control"] .tab-label').text()).toBe('会话控制');
  });

  it('registers and mounts the collaboration-agents dock pane', async () => {
    wrapper = mountShell();
    openDockTab('agents');
    await flushPromises();
    const pane = wrapper.find('.dock-pane--agents');
    expect(pane.exists()).toBe(true);
    expect(pane.find('.subagents-panel').exists()).toBe(true);
    expect(wrapper.find('.tab-button[data-kind="agents"] .tab-label').text()).toBe('协作代理');
  });

  it('mounts a pane when a session tab opens and keeps it mounted while hidden', async () => {
    wrapper = mountShell();
    expect(wrapper.find('.right-panel').exists()).toBe(false);

    openDockTab('git');
    await flushPromises();
    const gitPane = wrapper.find('.dock-pane--git');
    expect(gitPane.exists()).toBe(true);
    // The real GitPanel rendered inside the registered pane.
    expect(gitPane.find('.git-panel').exists()).toBe(true);
    expect(gitPane.attributes('style') ?? '').not.toContain('display: none');

    // Selecting another tab hides the git pane via v-show only: the same DOM
    // node must stay attached, i.e. the component was NOT unmounted.
    openDockTab('todo');
    await flushPromises();
    const gitEl = wrapper.find('.dock-pane--git').element;
    expect(gitEl.getAttribute('style')).toContain('display: none');
    expect(document.contains(gitEl)).toBe(true);
    expect(wrapper.find('.dock-pane--todo .todo-panel').exists()).toBe(true);

    // Re-selecting activates the still-mounted pane (identity preserved).
    selectDockTab('dock:git');
    await flushPromises();
    const sameEl = wrapper.find('.dock-pane--git').element;
    expect(sameEl).toBe(gitEl);
    expect(sameEl.getAttribute('style') ?? '').not.toContain('display: none');
  });

  it('pins the detail pane by content, and closing the neighbour falls back to it', async () => {
    wrapper = mountShell();
    openDockTab('detail');
    await flushPromises();
    const detailPane = wrapper.find('.dock-pane--detail');
    expect(detailPane.exists()).toBe(true);
    expect(detailPane.attributes('data-dock-tab')).toBe('detail');
    // Content-level anchors, matching the sibling panes (.git-panel / .todo-panel /
    // .run-status): the detail pane really mounts SessionDetailView's stacked panel
    // instead of an empty shell.
    expect(detailPane.find('.detail-view').exists()).toBe(true);
    expect(detailPane.find('.run-status').exists()).toBe(true);
    expect(detailPane.find('.git-panel').exists()).toBe(true);
    expect(detailPane.find('.todo-panel').exists()).toBe(true);
    // Tab strip: the label and the active state follow the selected item.
    const detailTab = wrapper.find('.tab-button[data-kind="detail"]');
    expect(detailTab.find('.tab-label').text()).toBe('会话详情');
    expect(detailTab.classes()).toContain('active');
    expect(detailTab.attributes('aria-selected')).toBe('true');

    // Switching to another tab only hides the detail pane through v-show (the DOM
    // node is not rebuilt).
    openDockTab('todo');
    await flushPromises();
    const detailEl = wrapper.find('.dock-pane--detail').element;
    expect(detailEl.getAttribute('style')).toContain('display: none');
    expect(document.contains(detailEl)).toBe(true);
    expect(wrapper.find('.tab-button[data-kind="detail"]').classes()).not.toContain('active');

    // Closing the last tab (no successor) → falls back to the previous tab: the
    // detail pane becomes the active, visible one again.
    closeDockTab('dock:todo');
    await flushPromises();
    expect(dockPanel.activeTabId).toBe('dock:detail');
    expect(wrapper.find('.dock-pane--detail').element).toBe(detailEl);
    expect(wrapper.find('.dock-pane--detail').attributes('style') ?? '').not.toContain('display: none');
    expect(wrapper.find('.tab-button[data-kind="detail"]').classes()).toContain('active');
  });

  it('wires the git pane listeners through the shell (refresh hits the client)', async () => {
    wrapper = mountShell();
    openDockTab('git');
    await flushPromises();
    await wrapper.find('.dock-pane--git button[aria-label="刷新 Git 状态"]').trigger('click');
    // The mock client is module-level, so assert wiring, not a pristine count.
    const fetchGitStatus = shared.client!.fetchGitStatus as ReturnType<typeof vi.fn>;
    expect(fetchGitStatus).toHaveBeenCalled();
  });

  it('hides the file pane only when a session tab is active', async () => {
    wrapper = mountShell();
    openFileInPanel('/src/a.ts');
    await flushPromises();
    const filePane = wrapper.find('.dock-pane--file');
    expect(filePane.attributes('style') ?? '').not.toContain('display: none');
    openDockTab('run');
    await flushPromises();
    expect(filePane.attributes('style')).toContain('display: none');
    expect(wrapper.find('.dock-pane--run .run-status').exists()).toBe(true);
  });
});

describe('session-level tab singleton', () => {
  it('re-opening a session kind activates instead of creating a second tab', async () => {
    wrapper = mountShell();
    openDockTab('goal');
    await flushPromises();
    openDockTab('goal');
    await flushPromises();
    expect(dockPanel.tabs.filter((t) => t.kind === 'goal')).toHaveLength(1);
    expect(wrapper.findAll('.tab-button[data-kind="goal"]')).toHaveLength(1);
    expect(wrapper.findAll('.dock-pane--goal')).toHaveLength(1);
  });

  it('file tabs stay multi-instance beside the singletons', async () => {
    wrapper = mountShell();
    openFileInPanel('/src/a.ts');
    openFileInPanel('/src/b.ts');
    openDockTab('git');
    openDockTab('git');
    await flushPromises();
    expect(wrapper.findAll('.tab-button[data-kind="file"]')).toHaveLength(2);
    expect(wrapper.findAll('.tab-button[data-kind="git"]')).toHaveLength(1);
  });

  it('connects the active file tab to the shared file tabpanel', async () => {
    wrapper = mountShell();
    openFileInPanel('/src/a.ts');
    await flushPromises();

    const fileTab = wrapper.find('.tab-button[data-kind="file"]');
    const filePane = wrapper.find('.dock-pane--file');
    expect(fileTab.attributes('aria-controls')).toBe(filePane.attributes('id'));
    expect(filePane.attributes('id')).toBe('dock-panel-file-pane');
    expect(filePane.attributes('aria-labelledby')).toBe(fileTab.attributes('id'));

    // A second file instance still points at the same mounted pane when it is
    // selected; the tab strip must not manufacture an id from the file path.
    openFileInPanel('/src/b.ts');
    await flushPromises();
    const activeFileTab = wrapper.find('.tab-button[data-kind="file"].active');
    expect(activeFileTab.attributes('aria-controls')).toBe('dock-panel-file-pane');
    expect(wrapper.find('.dock-pane--file').attributes('aria-labelledby')).toBe(activeFileTab.attributes('id'));
  });

  it('does not expose a synthetic tab label when a persisted dock has no tabs', async () => {
    wrapper = mountShell();
    setDockOpen(true);
    await flushPromises();
    const filePane = wrapper.find('.dock-pane--file');
    expect(filePane.exists()).toBe(true);
    expect(filePane.attributes('aria-labelledby')).toBeUndefined();
  });

  it('exposes keyboard-operable tab semantics without nesting the close control', async () => {
    wrapper = mountShell();
    openDockTab('git');
    openDockTab('todo');
    await flushPromises();

    const tabs = wrapper.findAll('.tab-button');
    expect(tabs[0]!.attributes('role')).toBe('tab');
    expect(tabs[0]!.element.parentElement?.getAttribute('role')).toBe('presentation');
    expect(tabs[0]!.attributes('tabindex')).toBe('-1');
    expect(tabs[1]!.attributes('tabindex')).toBe('0');
    expect(tabs[1]!.find('button').exists()).toBe(false);

    await tabs[0]!.trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(dockPanel.activeTabId).toBe('dock:todo');
    expect(document.activeElement?.id).toBe(tabs[1]!.attributes('id'));

    const pane = wrapper.find('.dock-pane--todo');
    expect(tabs[1]!.attributes('aria-controls')).toBe(pane.attributes('id'));
    expect(pane.attributes('role')).toBe('tabpanel');
    expect(pane.attributes('aria-labelledby')).toBe(tabs[1]!.attributes('id'));
  });
});

describe('right dock collapse / expand', () => {
  it('the chrome collapse button folds the dock and keeps the tab list', async () => {
    wrapper = mountShell();
    openDockTab('like');
    await flushPromises();
    expect(wrapper.find('.right-panel').exists()).toBe(true);
    await wrapper.find('.dock-chrome-collapse').trigger('click');
    expect(wrapper.find('.right-panel').exists()).toBe(false);
    expect(dockPanel.panelOpen).toBe(false);
    expect(dockPanel.tabs).toHaveLength(1); // folded, not closed
  });

  it('setDockOpen re-expands with the previous active tab', async () => {
    wrapper = mountShell();
    openDockTab('git');
    openDockTab('todo');
    setDockOpen(false);
    await flushPromises();
    expect(wrapper.find('.right-panel').exists()).toBe(false);
    setDockOpen(true);
    await flushPromises();
    expect(wrapper.find('.right-panel').exists()).toBe(true);
    expect(wrapper.find('.dock-pane--todo').attributes('style') ?? '').not.toContain('display: none');
  });

  it('the chrome maximise button lifts the dock out of the grid', async () => {
    wrapper = mountShell();
    openDockTab('detail');
    await flushPromises();
    const expandBtn = wrapper.findAll('.dock-chrome-btn')[0]!;
    await expandBtn.trigger('click');
    expect(wrapper.find('.right-panel').classes()).toContain('maximized');
    expect(wrapper.find('.panel-resize-handle--right').exists()).toBe(false);
    await wrapper.findAll('.dock-chrome-btn')[0]!.trigger('click');
    expect(wrapper.find('.right-panel').classes()).not.toContain('maximized');
  });

  it('closing the last tab collapses the dock', async () => {
    wrapper = mountShell();
    openDockTab('git');
    await flushPromises();
    closeDockTab('dock:git');
    await flushPromises();
    expect(wrapper.find('.right-panel').exists()).toBe(false);
  });
});

describe('responsive: <768px overlay float', () => {
  it('renders the dock as a full-screen overlay with backdrop below the split width', async () => {
    spyInnerWidth(700);
    wrapper = mountShell();
    openDockTab('detail');
    await flushPromises();
    expect(wrapper.find('.right-panel').classes()).toContain('overlay');
    expect(wrapper.find('.right-panel-backdrop').exists()).toBe(true);
    expect(wrapper.find('.right-panel').attributes('role')).toBe('dialog');
    expect(wrapper.find('.right-panel').attributes('aria-modal')).toBe('true');
    expect(wrapper.find('.panel-resize-handle--right').exists()).toBe(false);
    // The maximise control is pointless on an already full-screen float;
    // the collapse control stays.
    expect(wrapper.find('.dock-chrome-maximize').exists()).toBe(false);
    expect(wrapper.find('.dock-chrome-collapse').exists()).toBe(true);
  });
});

describe('responsive: <1024px auto rail', () => {
  it('matchMedia collapses the sidebar to the 56px track and hides its handle', async () => {
    stubMatchMedia(true);
    spyInnerWidth(900);
    wrapper = mountShell();
    await flushPromises();
    const shell = wrapper.find('.shell');
    expect(shell.classes()).toContain('sidebar-collapsed');
    expect(shell.attributes('style')).toContain('--sidebar-track: 56px');
    expect(wrapper.find('.sidebar-stub').classes()).toContain('collapsed');
    expect(wrapper.find('.panel-resize-handle--left').exists()).toBe(false);
  });

  it('a manual expand from the rail raises the overlay sidebar instead of the track', async () => {
    stubMatchMedia(true);
    spyInnerWidth(900);
    wrapper = mountShell();
    await wrapper.find('.stub-rail-toggle').trigger('click');
    expect(wrapper.find('.sidebar-mobile').exists()).toBe(true);
    expect(wrapper.find('.sidebar-backdrop').exists()).toBe(true);
    expect(wrapper.find('.sidebar-mobile').attributes('role')).toBe('dialog');
    expect(wrapper.find('.sidebar-mobile').attributes('aria-modal')).toBe('true');
    // The grid track never widens in the compact band.
    expect(wrapper.find('.shell').attributes('style')).toContain('--sidebar-track: 56px');
  });

  it('widen back above the breakpoint restores the desktop track', async () => {
    stubMatchMedia(false);
    spyInnerWidth(1200);
    wrapper = mountShell();
    await flushPromises();
    const style = wrapper.find('.shell').attributes('style') ?? '';
    expect(style).toContain('--sidebar-track: 288px');
    expect(wrapper.find('.panel-resize-handle--left').exists()).toBe(true);
  });
});

describe('ConversationHeader dock button (drawer retirement)', () => {
  it('the right-dock button opens the session detail tab and toggles by state', async () => {
    setDockOpen(false);
    dockPanel.tabs = [];
    const header = mount(ConversationHeader, {
      props: { title: 't', busy: false, statsOpen: false, turnTokens: null },
      global: { stubs: { SvgIcon: true } },
    });
    const dockBtn = header.findAll('.ghost-btn')[3]!;
    expect(dockBtn.attributes('title')).toBe('打开右栏');
    await dockBtn.trigger('click');
    expect(dockPanel.panelOpen).toBe(true);
    expect(dockPanel.activeTabId).toBe('dock:detail');
    expect(dockBtn.attributes('title')).toBe('收起右栏');
    await dockBtn.trigger('click');
    expect(dockPanel.panelOpen).toBe(false);
    header.unmount();
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

import Composer from '../../src/web/frontend/src/components/Composer.vue';
import {
  WORKSPACE_PREF_KEY,
  setPreferredWorkDir,
  useWorkspacePreference,
} from '../../src/web/frontend/src/composables/useWorkspacePreference';
import { createSessionsModule } from '../../src/web/frontend/src/composables/webClient/sessions';
import { createClientContext } from '../../src/web/frontend/src/composables/webClient/state';

/**
 * The frontend path of workspace selection:
 * 1. sessions.createSession(workDir) -> the POST /sessions payload carries { workDir };
 *    when omitted there is no body;
 * 2. creation failure -> the toast prefers the server message (an invalid directory has
 *    to be explained in plain words);
 * 3. the workspace chip on the home Composer -> WorkspacePicker: typing/picking writes
 *    the preference (in memory + the localStorage scream-workspace-preference key) and
 *    the chip label follows;
 * 4. chat variant: the chip is read-only (disabled + a title saying it cannot be
 *    changed mid-session).
 *
 * The popover now teleports to body with fixed positioning (the original absolute one
 * was clipped inside the .composer-chips overflow container, so a real click could not
 * open it), and the assertions query document accordingly.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountComposer(over: Record<string, unknown> = {}): any {
  return mount(Composer, {
    props: {
      busy: false,
      status: { busy: false, model: 'm', connectionStatus: 'connected' },
      models: [],
      variant: 'home',
      connectionStatus: 'connected',
      ...over,
    },
    global: { stubs: { SvgIcon: true, ContextRing: true } },
    attachTo: document.body,
  });
}

beforeEach(() => {
  localStorage.clear();
  setPreferredWorkDir(null);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** The popover itself: the teleported .workspace-picker (the in-place anchor carries a --anchor suffix and is excluded). */
function pickerEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.workspace-picker:not(.workspace-picker--anchor)');
}

/** The teleported popover is not part of the wrapper tree, so interaction uses native events (as in a real browser). */
async function typePath(value: string): Promise<void> {
  const input = pickerEl()!.querySelector<HTMLInputElement>(
    '[data-testid="workspace-path-input"]',
  )!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}

function applyButton(): HTMLButtonElement {
  return pickerEl()!.querySelector<HTMLButtonElement>('[data-testid="workspace-apply"]')!;
}

describe('workspace chip (home variant)', () => {
  it('shows the default workspace with nothing picked; opening it and entering an absolute path writes localStorage and updates the label', async () => {
    const wrapper = mountComposer();
    const chip = wrapper.find('[data-chip="workspace"]');
    expect(chip.exists()).toBe(true);
    expect(chip.attributes('disabled')).toBeUndefined();
    // the default preference was cleared -> the fallback wording shows
    expect(chip.text()).toContain('默认工作区');

    await chip.trigger('click');
    const picker = pickerEl();
    expect(picker).not.toBeNull();
    // The popover hangs off body: it no longer lands inside .composer-chips (that
    // overflow container would clip it entirely).
    expect(picker!.parentElement).toBe(document.body);
    expect(picker!.closest('.composer-chips')).toBeNull();
    expect(picker!.style.position).toBe('fixed');
    // The "recent" section is not rendered when it is not derived from the session list
    expect(picker!.textContent).toContain('工作区（下一次新建）');

    await typePath('/home/user/project');
    applyButton().click();
    await flushPromises();

    expect(localStorage.getItem(WORKSPACE_PREF_KEY)).toBe('/home/user/project');
    expect(useWorkspacePreference().preferredWorkDir.value).toBe('/home/user/project');
    // The popover closes (its anchor disappears with the component unmount) and the chip
    // switches to the local basename with the full path in title
    expect(pickerEl()).toBeNull();
    expect(wrapper.find('.workspace-picker').exists()).toBe(false);
    const chip2 = wrapper.find('[data-chip="workspace"]');
    expect(chip2.text()).toContain('project');
    expect(chip2.attributes('title')).toContain('/home/user/project');
  });

  it('a relative path cannot be submitted; the recent list is clickable', async () => {
    const wrapper = mountComposer({ recentWorkDirs: ['/home/u/project-a', '/home/u/project-b'] });
    await wrapper.find('[data-chip="workspace"]').trigger('click');
    const rows = Array.from(pickerEl()!.querySelectorAll<HTMLButtonElement>('.picker-row'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('project-a');

    await typePath('relative/nope');
    expect(applyButton().disabled).toBe(true);
    expect(pickerEl()!.textContent).toContain('需要绝对路径');

    rows[1]!.click();
    await flushPromises();
    expect(localStorage.getItem(WORKSPACE_PREF_KEY)).toBe('/home/u/project-b');
  });

  it('chat variant: the chip is read-only, disabled, with a title saying it cannot be changed mid-session', async () => {
    const wrapper = mountComposer({ variant: 'chat', workDir: '/srv/app', sessionId: 's-1' });
    const chip = wrapper.find('[data-chip="workspace"]');
    expect(chip.text()).toContain('app');
    expect(chip.attributes('disabled')).toBeDefined();
    expect(chip.attributes('title')).toContain('工作区随会话创建，不可中途更换');
    await chip.trigger('click');
    expect(pickerEl()).toBeNull();
    expect(wrapper.find('.workspace-picker').exists()).toBe(false);
  });
});

describe('sessions.createSession payload and failure toast', () => {
  function makeModule() {
    const ctx = createClientContext();
    const showToast = vi.fn();
    ctx.showToast = showToast;
    ctx.connect = vi.fn();
    ctx.stopHeartbeat = vi.fn();
    ctx.resetGoalRequestState = vi.fn();
    const mod = createSessionsModule(ctx);
    return { ctx, mod, showToast };
  }

  it('with workDir the POST payload is { workDir }; when omitted there is no body', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: { body?: string }) => ({
      ok: true,
      status: 201,
      json: async () => ({ sessionId: 'new-1', workDir: '/picked/dir', title: 't', createdAt: 1, messageCount: 0, active: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { ctx, mod } = makeModule();

    await mod.createSession('/picked/dir');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('/api/v1/sessions');
    expect(init?.body).toBe(JSON.stringify({ workDir: '/picked/dir' }));
    expect(ctx.s.currentSessionId.value).toBe('new-1');

    await mod.createSession();
    expect(fetchMock.mock.calls[1]![1]?.body).toBeUndefined();
  });

  it('an invalid directory -> the toast forwards the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ code: 'request.invalid', message: '目录不存在：/nope' }),
    })));
    const { mod, showToast } = makeModule();
    await mod.createSession('/nope');
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('目录不存在：/nope'),
      'error',
    );
  });
});

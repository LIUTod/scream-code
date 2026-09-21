// @vitest-environment jsdom
import { computed, defineComponent, h, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import SessionDetailView from '../../src/web/frontend/src/components/SessionDetailView.vue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function clientFixture() {
  const currentSessionId = ref<string | null>('session-a');
  const sessionId = ref<string | null>('session-a');
  return {
    currentSessionId,
    sessionId,
    status: ref({ busy: false }),
    connectionStatus: ref('connected'),
    isBusy: computed(() => false),
    isArchived: ref(false),
    goal: ref(null),
    todos: ref([]),
    goalRequestPending: ref(false),
    goalRequestError: ref(null),
    like: ref({}),
    gitStatus: ref({ isRepo: true, branch: 'main', changed: 1, files: [] }),
    fetchGitStatus: vi.fn(async () => undefined),
    updateLike: vi.fn(async () => true),
    refineGoal: vi.fn(async () => null),
    createGoal: vi.fn(async () => true),
    updateGoal: vi.fn(async () => true),
    pauseGoal: vi.fn(async () => true),
    resumeGoal: vi.fn(async () => true),
    cancelGoal: vi.fn(async () => true),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('SessionDetailView workspace boundaries', () => {
  it('drops a late diff response when the selected session changes', async () => {
    const fixture = clientFixture();
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const GitPanelStub = defineComponent({
      emits: ['diff', 'refresh'],
      setup(_, { emit }) {
        return () => h('button', {
          class: 'open-diff',
          onClick: () => emit('diff', { path: 'src/a.ts', display: 'src/a.ts' }),
        }, 'open');
      },
    });
    const EmptyStub = defineComponent({ template: '<div />' });
    const wrapper = mount(SessionDetailView, {
      props: { client: fixture as never },
      global: {
        stubs: {
          GitPanel: GitPanelStub,
          RunStatusPanel: EmptyStub,
          TodoPanel: EmptyStub,
          LikePanel: EmptyStub,
          GoalPanel: EmptyStub,
          DiffLines: EmptyStub,
        },
      },
    });

    await wrapper.find('.open-diff').trigger('click');
    fixture.currentSessionId.value = 'session-b';
    pending.resolve({
      ok: true,
      status: 200,
      json: async () => ({ patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n' }),
    } as Response);
    await flushPromises();

    expect(wrapper.find('.git-diff-view').exists()).toBe(false);
  });
});

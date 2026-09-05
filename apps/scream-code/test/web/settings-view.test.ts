// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import SettingsView from '../../src/web/frontend/src/components/SettingsView.vue';

/** The settings view reads from a `client` harness object whose members are
 *  composable-returned Refs (like useScreamWebClient). Build one with the
 *  same shape so the unwrap logic is exercised for real. */
function fakeClient(overrides: Record<string, unknown> = {}) {
  const models = ref([
    { alias: 'm1', provider: 'p1', model: 'm1/x', displayName: 'Model One', maxContextSize: 1000 },
    { alias: 'm2', provider: 'p2', model: 'm2/y', displayName: 'Model Two', maxContextSize: 2000 },
  ]);
  const skills = ref([
    { name: 'skill-a', description: 'A skill' },
    { name: 'skill-b', description: 'B skill', pluginId: 'some-plugin' },
  ]);
  const plugins = ref([
    { id: 'plg1', displayName: 'Plugin One', version: '1.0.0', enabled: true, skillCount: 1, mcpServerCount: 0, enabledMcpServerCount: 0 },
  ]);
  const mcpServers = ref([
    { name: 'mcp-x', transport: 'stdio', status: 'connected', toolCount: 5 },
  ]);
  const backgroundTasks = ref([
    { taskId: 't1', command: 'echo hi', description: 'Say hi', status: 'running' },
  ]);
  const status = ref({ model: 'm1' });
  const actions: Record<string, ReturnType<typeof vi.fn>> = {
    fetchModels: vi.fn(async () => undefined),
    fetchConfig: vi.fn(async () => undefined),
    fetchSkills: vi.fn(async () => undefined),
    fetchPlugins: vi.fn(async () => undefined),
    fetchMcpServers: vi.fn(async () => undefined),
    fetchBackgroundTasks: vi.fn(async () => undefined),
    switchModel: vi.fn(async () => undefined),
    activateSkill: vi.fn(async () => true),
    removeSkill: vi.fn(async () => true),
    setPluginEnabled: vi.fn(async () => true),
    installPlugin: vi.fn(async () => ({ displayName: 'Installed' })),
    reconnectMcpServer: vi.fn(async () => true),
    stopMcpServer: vi.fn(async () => true),
    removeMcpServer: vi.fn(async () => true),
    stopBackgroundTask: vi.fn(async () => true),
    fetchBackgroundTaskOutput: vi.fn(async () => undefined),
  };
  const client = { models, skills, plugins, mcpServers, backgroundTasks, status, ...actions, ...overrides };
  return { client, actions, models, skills, plugins, mcpServers, backgroundTasks };
}

function mountView(client: ReturnType<typeof fakeClient>['client']) {
  return mount(SettingsView, {
    props: { client },
    global: {
      provide: {
        theme: ref('system'),
        setTheme: (_t: string) => {},
      },
      stubs: { SvgIcon: true },
    },
  });
}

describe('SettingsView (G4)', () => {
  it('fetches real data for every section on mount', () => {
    const { client, actions } = fakeClient();
    mountView(client);
    expect(actions.fetchModels).toHaveBeenCalledTimes(1);
    expect(actions.fetchConfig).toHaveBeenCalledTimes(1);
    expect(actions.fetchSkills).toHaveBeenCalledTimes(1);
    expect(actions.fetchPlugins).toHaveBeenCalledTimes(1);
    expect(actions.fetchMcpServers).toHaveBeenCalledTimes(1);
    expect(actions.fetchBackgroundTasks).toHaveBeenCalledTimes(1);
  });

  it('renders the section rail with all sections', () => {
    const { client } = fakeClient();
    const wrapper = mountView(client);
    const tabs = wrapper.findAll('.rail-tab').map((n) => n.text());
    expect(tabs).toContain('通用');
    expect(tabs).toContain('模型');
    expect(tabs).toContain('技能');
    expect(tabs).toContain('插件');
    expect(tabs).toContain('MCP 服务器');
    expect(tabs).toContain('后台任务');
  });

  it('shows the general pane by default with theme options', () => {
    const { client } = fakeClient();
    const wrapper = mountView(client);
    expect(wrapper.text()).toContain('通用设置');
    expect(wrapper.text()).toContain('外观');
    expect(wrapper.text()).toContain('偏好设置');
  });

  it('renders models with displayName/provider/context (unwrapped refs)', async () => {
    const { client } = fakeClient();
    const wrapper = mountView(client);
    await wrapper.find('.rail-tab:nth-child(2)').trigger('click');
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain('Model One');
    expect(text).toContain('p1 · m1 · 1000');
    expect(text).toContain('Model Two');
    // The active model shows 使用中, others 切换.
    const actions = wrapper.findAll('.list-row .row-action').map((n) => n.text());
    expect(actions).toContain('切换');
  });

  it('renders skills with description and plugin origin', async () => {
    const { client } = fakeClient();
    const wrapper = mountView(client);
    await wrapper.findAll('.rail-tab')[2].trigger('click');
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain('skill-a');
    expect(text).toContain('skill-b');
    expect(text).toContain('来自插件 some-plugin');
  });

  it('renders plugins and toggles enable state via client.setPluginEnabled', async () => {
    const { client, actions } = fakeClient();
    const wrapper = mountView(client);
    await wrapper.findAll('.rail-tab')[3].trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Plugin One');
    const toggle = wrapper.find('.list-row .row-action');
    await toggle.trigger('click');
    await flushPromises();
    expect(actions.setPluginEnabled).toHaveBeenCalledWith('plg1', false);
  });

  it('renders MCP servers with status pill and actions', async () => {
    const { client } = fakeClient();
    const wrapper = mountView(client);
    await wrapper.findAll('.rail-tab')[4].trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('mcp-x');
    expect(wrapper.text()).toContain('connected');
    expect(wrapper.text()).toContain('重连');
    expect(wrapper.text()).toContain('停止');
    expect(wrapper.text()).toContain('移除');
  });

  it('renders background tasks and empty state', async () => {
    const { client } = fakeClient();
    const wrapper = mountView(client);
    await wrapper.findAll('.rail-tab')[5].trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('echo hi');
    expect(wrapper.text()).toContain('running');
    expect(wrapper.text()).toContain('停止');
  });

  it('emits update-like when saving preferences', async () => {
    const { client } = fakeClient();
    const wrapper = mountView(client);
    const input = wrapper.find('.like-input');
    await input.setValue('🥔老师');
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存偏好'));
    expect(saveBtn).toBeTruthy();
    await saveBtn!.trigger('click');
    await flushPromises();
    const emitted = wrapper.emitted('update-like');
    expect(emitted).toBeTruthy();
    expect((emitted![0]![0] as { nickname?: string }).nickname).toBe('🥔老师');
  });
});

/**
 * knowledge-web.test.ts — /knowledge web 的 TS 服务端面测试（批次 B4）。
 *
 * 1100 行内嵌浏览器 JS（HTML 模板 :42-1135）明确不测；这里只测：
 * - handleWeb 空库抛错（不启 server）；
 * - /api/graph 的 JSON 字段白名单 + event→entity join；
 * - serveHTML 的 __DICT_INJECT__ / __LOCALE_INJECT__ 替换；
 * - 未知路由回退 HTML、graph 异常 → 500；
 * - openUrl / showStatus / heartbeat SSE 与 server 生命周期清理。
 *
 * 手法：真起 ephemeral server（listen 0）+ 真 fetch。通过 vi.mock('node:http')
 * 包装 createServer 捕获 server 实例，afterEach 里 closeAllConnections + close，
 * 保证不遗留悬挂 server/timer（vitest 正常退出）。
 * 已知点：knowledge-web.ts:38 在模块加载时注册一个 process 'exit' listener，
 * 属模块级一次性注册（见"exit listener"用例的容忍说明）。
 */
import type { Server } from 'node:http';
import { t, getLocale } from '@scream-code/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands/dispatch';

// ─── mocks ──────────────────────────────────────────────────────────

const cap = vi.hoisted(() => ({
  servers: [] as Server[],
  store: null as Record<string, any> | null,
}));

// 捕获 createServer 产物，测试内可确定性地关闭 server。
vi.mock('node:http', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:http')>();
  return {
    ...orig,
    createServer: (...args: unknown[]) => {
      const server = (orig.createServer as (
        ...a: unknown[]
      ) => Server)(...args);
      cap.servers.push(server);
      return server;
    },
  };
});

const ui = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock('#/tui/utils/open-url', () => ({ openUrl: ui.openUrl }));

vi.mock('#/tui/commands/knowledge-store', () => ({
  getKnowledgeStore: vi.fn(async () => cap.store),
}));

// 基线必须在动态 import 被测模块之前采样：knowledge-web 模块级注册
// 恰好 1 个 process 'exit' listener（closeAllServers）。
const exitBeforeImport = process.listenerCount('exit');
const webModule = await import('#/tui/commands/knowledge-web');
const exitAfterImport = process.listenerCount('exit');

// ─── fixtures ───────────────────────────────────────────────────────

function makeHost() {
  return {
    showStatus: vi.fn(),
    showError: vi.fn(),
    state: { theme: { colors: {} }, terminal: {} },
  } as unknown as SlashCommandHost;
}

function makeStore(overrides: Record<string, any> = {}) {
  return {
    stats: vi.fn(async () => ({ sources: 1, documents: 1, chunks: 1, events: 1, entities: 1 })),
    listEntities: vi.fn(async () => []),
    listEvents: vi.fn(async () => []),
    listEventEntities: vi.fn(async () => []),
    listSources: vi.fn(async () => []),
    ...overrides,
  };
}

/** 起一个临时 server 并返回其 base url（handleWeb 通过 openUrl 暴露）。 */
async function startServer(host = makeHost()): Promise<string> {
  await webModule.handleWeb(host);
  const url = ui.openUrl.mock.calls.at(-1)![0] as string;
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  return url;
}

beforeEach(() => {
  ui.openUrl.mockReset();
  cap.servers.length = 0;
});

afterEach(async () => {
  for (const server of cap.servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  // 让 res 'close'（heartbeat clearInterval）回调落地
  await new Promise((resolve) => setImmediate(resolve));
});

// ─── 用例 ───────────────────────────────────────────────────────────

describe('handleWeb — 生命周期', () => {
  it('空库（entities=0 且 events=0）→ 抛 knowledge.empty_store，不启 server 不开浏览器', async () => {
    cap.store = makeStore({
      stats: vi.fn(async () => ({ sources: 0, documents: 0, chunks: 0, events: 0, entities: 0 })),
    });
    const host = makeHost();
    await expect(webModule.handleWeb(host)).rejects.toThrow(t('knowledge.empty_store'));
    expect(cap.servers).toHaveLength(0);
    expect(ui.openUrl).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
  });

  it('process exit listener 仅在模块加载时注册一次，重复 import/handleWeb 不累积', async () => {
    // 模块级注册 = 已知且容忍的 +1（knowledge-web.ts:38 closeAllServers 兜底）
    expect(exitAfterImport - exitBeforeImport).toBe(1);

    // 二次 import 命中模块缓存，不再注册
    const again = await import('#/tui/commands/knowledge-web');
    expect(again.handleWeb).toBe(webModule.handleWeb);
    expect(process.listenerCount('exit')).toBe(exitAfterImport);

    // handleWeb 每次调用也不注册 listener
    cap.store = makeStore();
    await startServer();
    expect(process.listenerCount('exit')).toBe(exitAfterImport);
  });

  it('re-opening 驱逐旧 graph server（同一时刻至多一个 viewer；旧端口停止监听）', async () => {
    cap.store = makeStore();
    const url1 = await startServer();
    expect(cap.servers).toHaveLength(1);

    const url2 = await startServer();
    expect(cap.servers).toHaveLength(2);
    expect(url2).not.toBe(url1);

    // 修复前：handleWeb 从不关旧 server，反复开累积多端口。
    // 重开后旧 server 已 closeAllServers：listen 释放，旧端口拒连；新端口正常。
    await expect(fetch(`${url1}/api/graph`)).rejects.toThrow();
    const res = await fetch(`${url2}/api/graph`);
    expect(res.status).toBe(200);
  });

  it('handleWeb → openUrl 带 127.0.0.1 临时端口 + showStatus 报已打开；未知路由回退 serveHTML', async () => {
    cap.store = makeStore();
    const host = makeHost();
    const url = await startServer(host);

    expect(host.showStatus).toHaveBeenCalledWith(t('knowledge.web_opened', { url }));
    expect(cap.servers).toHaveLength(1);
    expect(cap.servers[0]!.listening).toBe(true);

    // 非 /api/* 路径全部落到 serveHTML
    const res = await fetch(`${url}/some/unknown/path`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });
});

describe('/api/graph', () => {
  it('返回字段白名单 JSON：entity/event 剥离多余字段、event.entityIds 按边序 join、sources 仅 id/name', async () => {
    cap.store = makeStore({
      listEntities: vi.fn(async () => [
        { id: 'e1', sourceId: 's1', type: 'person', name: 'Alice', normalizedName: 'alice', eventCount: 1, description: 'desc', embedding: [0.1, 0.2], createdAt: 'x' },
        { id: 'e2', sourceId: 's1', type: 'org', name: 'ACME', normalizedName: 'acme', eventCount: 0, description: '' },
      ]),
      listEvents: vi.fn(async () => [
        { id: 'ev1', sourceId: 's1', documentId: 'd1', title: 'Meet', rank: 2, summary: 'sum', category: 'cat', keywords: ['k1'], content: 'MUST-NOT-LEAK', createdAt: 'y' },
        { id: 'ev2', sourceId: 's1', documentId: 'd1', title: 'Solo', rank: 1, summary: '', category: '', keywords: [] },
      ]),
      listEventEntities: vi.fn(async () => [
        { eventId: 'ev1', entityId: 'e2', relation: 'actor' },
        { eventId: 'ev1', entityId: 'e1', relation: 'object' },
      ]),
      listSources: vi.fn(async () => [
        { id: 's1', name: 'Doc', filePath: '/a/b.md', kind: 'file', createdAt: 'z' },
      ]),
    });
    const url = await startServer();

    const res = await fetch(`${url}/api/graph`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');

    // 声明响应类型仅为断言服务：content/embedding 等字段预期不存在（undefined）
    interface GraphResponse {
      entities: Array<{ id: string; sourceId: string; type: string; name: string; normalizedName: string; eventCount: number; description: string; embedding?: unknown }>;
      events: Array<{ id: string; sourceId: string; documentId: string; title: string; rank: number; summary: string; category: string; keywords: string[]; entityIds: string[]; content?: unknown }>;
      edges: Array<{ eventId: string; entityId: string; relation: string }>;
      sources: Array<{ id: string; name: string }>;
    }
    const data = (await res.json()) as GraphResponse;
    expect(Object.keys(data).toSorted()).toEqual(['edges', 'entities', 'events', 'sources']);

    // entity 白名单：embedding/createdAt 等内部字段被剥离
    expect(Object.keys(data.entities[0]!).toSorted()).toEqual(
      ['description', 'eventCount', 'id', 'name', 'normalizedName', 'sourceId', 'type'].toSorted(),
    );
    // event 白名单 + entityIds join（保留边表顺序 e2 → e1）
    expect(Object.keys(data.events[0]!).toSorted()).toEqual(
      ['category', 'entityIds', 'id', 'keywords', 'rank', 'sourceId', 'summary', 'title', 'documentId'].toSorted(),
    );
    expect(data.events[0]!.entityIds).toEqual(['e2', 'e1']);
    expect(data.events[0]!.content).toBeUndefined();
    // 无关联事件的 entityIds 为空数组而非 undefined
    expect(data.events[1]!.entityIds).toEqual([]);
    // edges 原样透传
    expect(data.edges).toEqual([
      { eventId: 'ev1', entityId: 'e2', relation: 'actor' },
      { eventId: 'ev1', entityId: 'e1', relation: 'object' },
    ]);
    // sources 仅 id/name
    expect(data.sources).toEqual([{ id: 's1', name: 'Doc' }]);
  });

  it('store 查询抛错 → 500 + { error } JSON（不把异常裸抛给 fetch）', async () => {
    cap.store = makeStore({
      listEntities: vi.fn(async () => {
        throw new Error('sqlite exploded');
      }),
    });
    const url = await startServer();

    const res = await fetch(`${url}/api/graph`);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = (await res.json()) as { error?: string };
    expect(String(body.error)).toContain('sqlite exploded');
  });
});

describe('serveHTML 注入', () => {
  it('__DICT_INJECT__ 替换为可解析的双语字典、__LOCALE_INJECT__ 替换为当前 locale，无占位符残留', async () => {
    cap.store = makeStore();
    const url = await startServer();

    const html = await (await fetch(`${url}/`)).text();
    expect(html).not.toContain('__DICT_INJECT__');
    expect(html).not.toContain('__LOCALE_INJECT__');

    const dictMatch = html.match(/var DICT=(\{.*?\});\n/);
    expect(dictMatch).not.toBeNull();
    const dict = JSON.parse(dictMatch![1]!);
    expect(Object.keys(dict).toSorted()).toEqual(['en', 'zh']);
    expect(dict.zh.kw_title).toBe('知识图谱');
    expect(dict.en.kw_lang_toggle).toBe('中文');

    const localeMatch = html.match(/var curLang='([^']*)';/);
    expect(localeMatch![1]).toBe(getLocale());
  });
});

describe('/api/heartbeat', () => {
  it('SSE 流以 : ok 起始；客户端断开后 heartbeat 触发 server 关闭（timer 随 res close 清理）', async () => {
    cap.store = makeStore();
    const url = await startServer();
    const server = cap.servers[0]!;

    const res = await fetch(`${url}/api/heartbeat`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = res.body!.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toContain(': ok');

    // 关闭读端 → 服务端 res 'close' → clearInterval(15s heartbeat) + server.close()
    await reader.cancel();
    await vi.waitFor(() => {
      expect(server.listening).toBe(false);
    });
  });
});

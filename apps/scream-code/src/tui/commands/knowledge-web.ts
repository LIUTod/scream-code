/**
 * /knowledge web — 知识图谱可视化
 * 纯 Canvas 2D 自渲染（无任何外部依赖/CDN），打开即用。
 * 白底简约科技风：灰色小点星云 + 细黑线条 + 放大显示文字。
 */

import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { KnowledgeStore } from '@scream-code/knowledge';
import { t, getLocale } from '@scream-code/config';

import { openUrl } from '../utils/open-url';
import { getKnowledgeStore } from './knowledge-store';
import type { SlashCommandHost } from './dispatch';
import { KNOWLEDGE_WEB_HTML } from './knowledge-web-template';

// ─── Server lifecycle ────────────────────────────────────────────────

const activeServers = new Set<Server>();

const activeTimers = new Set<ReturnType<typeof setInterval>>();

/** Idle watchdog: closes all graph servers when no viewer kept them alive. */
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function registerServer(server: Server): void {
  activeServers.add(server);
  server.on('close', () => { activeServers.delete(server); });
}

function closeAllServers(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  for (const timer of activeTimers) {
    clearInterval(timer);
  }
  activeTimers.clear();
  for (const server of activeServers) {
    server.close();
  }
}

process.on('exit', closeAllServers);


// ─── Server ─────────────────────────────────────────────────────────

async function serveGraphJSON(store: KnowledgeStore, res: ServerResponse): Promise<void> {
  try {
    const [entities, events, edges, sources] = await Promise.all([
      store.listEntities(),
      store.listEvents(),
      store.listEventEntities(),
      store.listSources(),
    ]);

    const eventEntityMap = new Map<string, string[]>();
    for (const edge of edges) {
      const list = eventEntityMap.get(edge.eventId) ?? [];
      list.push(edge.entityId);
      eventEntityMap.set(edge.eventId, list);
    }

    const data = {
      entities: entities.map(({ id, sourceId, type, name, normalizedName, eventCount, description }) => ({
        id, sourceId, type, name, normalizedName, eventCount, description,
      })),
      events: events.map(({ id, sourceId, documentId, title, rank, summary, category, keywords }) => ({
        id, sourceId, documentId, title, rank, summary, category, keywords,
        entityIds: eventEntityMap.get(id) ?? [],
      })),
      edges,
      sources: sources.map(({ id, name }) => ({ id, name })),
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(error) }));
  }
}

function serveHTML(res: ServerResponse, locale: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  const dictJson = JSON.stringify({
    zh: {
      kw_title:'知识图谱',kw_entity:'实体 ',kw_event:'事件 ',kw_relation:'关系 ',
      kw_search_placeholder:'搜索节点…',kw_btn_reset:'重置',kw_btn_expand:'展开',
      kw_hint_drag:'拖拽平移 · 滚轮缩放 · 单击展开 · 双击查看详情',
      kw_loading:'加载中…',kw_back:'返回',kw_detail_related:'关联',
      kw_detail_description:'描述',kw_detail_category:'分类',kw_detail_keywords:'关键词',
      kw_loading_timeout:'加载超时',kw_no_data:'暂无数据',kw_no_data_hint:'请先用 /knowledge 导入文档',
      kw_lang_toggle:'English',
    },
    en: {
      kw_title:'Knowledge Graph',kw_entity:'Entities ',kw_event:'Events ',kw_relation:'Relations ',
      kw_search_placeholder:'Search nodes…',kw_btn_reset:'Reset',kw_btn_expand:'Expand',
      kw_hint_drag:'Drag to pan · Scroll to zoom · Click to expand · Double-click for details',
      kw_loading:'Loading…',kw_back:'Back',kw_detail_related:'Related',
      kw_detail_description:'Description',kw_detail_category:'Category',kw_detail_keywords:'Keywords',
      kw_loading_timeout:'Loading timed out',kw_no_data:'No data',kw_no_data_hint:'Please ingest documents with /knowledge first',
      kw_lang_toggle:'中文',
    },
  });
  const injected = KNOWLEDGE_WEB_HTML.replace('__DICT_INJECT__', dictJson).replace('__LOCALE_INJECT__', locale);
  res.end(injected);
}

// ─── Public API ─────────────────────────────────────────────────────

export async function handleWeb(host: SlashCommandHost): Promise<void> {
  const store = await getKnowledgeStore();
  const s = await store.stats();
  if (s.entities === 0 && s.events === 0) {
    throw new Error(t('knowledge.empty_store'));
  }

  // One graph viewer at a time: a re-open evicts previous servers (pages
  // that are still attached drain naturally — their heartbeat connections
  // stay usable until the tab closes).
  closeAllServers();

  const server = createServer((req, res) => {
    if (req.url === '/api/graph') {
      void serveGraphJSON(store, res);
      return;
    }
    if (req.url === '/api/heartbeat') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      const timer = setInterval(() => { res.write(': ping\n\n'); }, 15_000);
      activeTimers.add(timer);
      res.on('close', () => {
        clearInterval(timer);
        activeTimers.delete(timer);
        server.close();
      });
      res.write(': ok\n\n');
      return;
    }
    serveHTML(res, getLocale());
  });
  registerServer(server);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  // Idle watchdog: if the browser never attaches (openUrl silently fails or
  // the user dismisses the page), don't hold the ephemeral port until process
  // exit. unref keeps it from pinning the event loop (tests stay fast-exiting).
  idleTimer = setTimeout(() => {
    closeAllServers();
  }, 10 * 60_000);
  idleTimer.unref();
  openUrl(url);
  host.showStatus(t('knowledge.web_opened', { url }));
}

/**
 * knowledge.test.ts — /knowledge 菜单命令的行为分支测试（批次 B4）。
 *
 * 打桩面（全部为模块级 mock，避免真实 sqlite / 模型下载 / 网络）：
 * - `#/tui/commands/knowledge-store`：getKnowledgeStore 等单例入口；
 * - `@scream-code/knowledge`：ingestDirectory / ingestFile / isSupportedFile / multiSearch；
 * - 四个对话框组件模块：以轻量 class 捕获构造回调，测试内立即 resolve/reject；
 * - `#/tui/commands/knowledge-web`：避免菜单选 web 时真起 server。
 *
 * `stat()` 走真实 fs（mkdtemp 造目录/文件），保证目录/文件二分逻辑被真实验证。
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { t } from '@scream-code/config';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { handleKnowledgeCommand } from '#/tui/commands/knowledge';
import { darkColors } from '#/tui/theme/colors';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { IngestProgress } from '@scream-code/knowledge';

// ─── module mocks ───────────────────────────────────────────────────

const knowledgeStore = vi.hoisted(() => ({
  getKnowledgeStore: vi.fn(),
  getEmbeddingStatus: vi.fn<() => string>(() => 'ready'),
  startManualEmbeddingDownload: vi.fn(async () => ({ ok: true })),
  isEmbeddingModelCached: vi.fn(() => true),
}));
vi.mock('#/tui/commands/knowledge-store', () => knowledgeStore);

const knowledgePkg = vi.hoisted(() => ({
  ingestDirectory: vi.fn(),
  ingestFile: vi.fn(),
  isSupportedFile: vi.fn(() => true),
  multiSearch: vi.fn(),
}));
vi.mock('@scream-code/knowledge', () => knowledgePkg);

const webMock = vi.hoisted(() => ({ handleWeb: vi.fn(async () => {}) }));
vi.mock('#/tui/commands/knowledge-web', () => webMock);

interface DialogRecord {
  inputs: Array<{ onDone: (r: { kind: string; value?: string }) => void; opts: Record<string, unknown> }>;
  pickers: Array<Record<string, any>>;
  viewers: Array<Record<string, any>>;
  trees: Array<Record<string, any>>;
}

const dialogs = vi.hoisted<DialogRecord>(() => ({
  inputs: [],
  pickers: [],
  viewers: [],
  trees: [],
}));

vi.mock('#/tui/components/dialogs/text-input-dialog', () => ({
  TextInputDialogComponent: class {
    constructor(onDone: (r: { kind: string; value?: string }) => void, opts: Record<string, unknown>) {
      dialogs.inputs.push({ onDone, opts });
    }
  },
}));
vi.mock('#/tui/components/dialogs/choice-picker', () => ({
  ChoicePickerComponent: class {
    constructor(props: Record<string, any>) {
      dialogs.pickers.push(props);
    }
  },
}));
vi.mock('#/tui/components/dialogs/knowledge-result-viewer', () => ({
  KnowledgeResultViewer: class {
    constructor(props: Record<string, any>) {
      dialogs.viewers.push(props);
    }
  },
}));
vi.mock('#/tui/components/dialogs/knowledge-document-tree', () => ({
  KnowledgeDocumentTree: class {
    constructor(props: Record<string, any>) {
      dialogs.trees.push(props);
    }
  },
}));

// ─── local stubs（不依赖 test/tui/fixtures/mock-host.ts，批次并行创建中）──

interface Spinner {
  stop: Mock;
  setLabel: Mock;
}

interface HostBundle {
  host: SlashCommandHost;
  spinner: Spinner;
  generateText: Mock;
}

function makeHost(): HostBundle {
  const spinner: Spinner = { stop: vi.fn(), setLabel: vi.fn() };
  const generateText = vi.fn(async () => 'llm-ok');
  const host = {
    session: { generateText },
    state: {
      theme: { colors: darkColors },
      terminal: {},
    },
    showError: vi.fn(),
    showNotice: vi.fn(),
    showStatus: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showProgressSpinner: vi.fn(() => spinner),
  } as unknown as SlashCommandHost;
  return { host, spinner, generateText };
}

function makeStore(overrides: Record<string, any> = {}) {
  return {
    listSources: vi.fn(async () => []),
    deleteSource: vi.fn(async () => true),
    getEmbeddingEngine: vi.fn(() => ({ available: true })),
    embeddingCoverage: vi.fn(async () => ({ embedded: 0, total: 0 })),
    listDocuments: vi.fn(async () => []),
    listChunksByDocument: vi.fn(async () => []),
    getSource: vi.fn(async () => undefined),
    stats: vi.fn(async () => ({ sources: 0, documents: 0, chunks: 0, events: 0, entities: 0 })),
    reembedSource: vi.fn(),
    ...overrides,
  };
}

/** 打开菜单，返回 host 包。 */
async function openMenu(host: SlashCommandHost) {
  await handleKnowledgeCommand(host, '');
}

/** 在当前最新挂载的 ChoicePicker 上选择一个动作，并等待异步处理链完成。 */
async function selectMenuAction(value: string): Promise<void> {
  const picker = dialogs.pickers.at(-1);
  if (!picker) throw new Error('no choice picker mounted');
  (picker['onSelect'] as (v: string) => void)(value);
  await flush();
}

/**
 * 跨多轮事件循环排空异步链（handleIngest 内含真实 fs.stat，其回调在
 * 后续迭代的 poll 阶段完成，单轮 setImmediate 不够）。
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function lastInput() {
  return dialogs.inputs.at(-1)!;
}

/** 在 ingest 输入框提交一个路径。 */
async function submitPath(value: string): Promise<void> {
  lastInput().onDone({ kind: 'ok', value });
  await flush();
}

let tmpRoot = '';

beforeEach(async () => {
  dialogs.inputs.length = 0;
  dialogs.pickers.length = 0;
  dialogs.viewers.length = 0;
  dialogs.trees.length = 0;

  vi.mocked(knowledgeStore.getKnowledgeStore).mockReset();
  vi.mocked(knowledgeStore.getEmbeddingStatus).mockReset();
  vi.mocked(knowledgeStore.getEmbeddingStatus).mockReturnValue('ready' as never);
  vi.mocked(knowledgeStore.startManualEmbeddingDownload).mockReset();
  vi.mocked(knowledgeStore.startManualEmbeddingDownload).mockResolvedValue({ ok: true });
  vi.mocked(knowledgeStore.isEmbeddingModelCached).mockReset();
  vi.mocked(knowledgeStore.isEmbeddingModelCached).mockReturnValue(true);

  vi.mocked(knowledgePkg.ingestDirectory).mockReset();
  vi.mocked(knowledgePkg.ingestFile).mockReset();
  vi.mocked(knowledgePkg.isSupportedFile).mockReset();
  vi.mocked(knowledgePkg.isSupportedFile).mockReturnValue(true);
  vi.mocked(knowledgePkg.multiSearch).mockReset();
  vi.mocked(webMock.handleWeb).mockReset();

  tmpRoot = await mkdtemp(join(tmpdir(), 'scream-knowledge-cmd-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── 1. 菜单初始挂载：8 个动作 + embedding 状态 hint ────────────────

describe('handleKnowledgeCommand — 菜单', () => {
  it('挂载 8 项动作菜单；ready 状态 hint 无后缀，failed 状态 hint 带失败文案', async () => {
    const { host } = makeHost();
    await openMenu(host);

    expect(dialogs.pickers).toHaveLength(1);
    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(1);
    const picker = dialogs.pickers[0]!;
    expect(picker['options']).toHaveLength(8);
    expect((picker['options'] as Array<{ value: string }>).map((o) => o.value)).toEqual([
      'download-model',
      'ingest',
      'list',
      'search',
      'delete',
      'reembed',
      'stats',
      'web',
    ]);
    // status === 'ready' → formatEmbeddingHint 返回空串，且 download 项标注已安装
    expect(picker['hint']).toBe(t('knowledge.menu_hint'));
    const downloadLabel = (picker['options'] as Array<{ value: string; label: string }>).find(
      (o) => o.value === 'download-model',
    )!.label;
    expect(downloadLabel).toContain(t('knowledge.download_model_installed'));

    // failed 状态 → hint 拼接失败文案 + 数据完好提示
    vi.mocked(knowledgeStore.getEmbeddingStatus).mockReturnValue('failed' as never);
    const { host: host2 } = makeHost();
    await openMenu(host2);
    const picker2 = dialogs.pickers.at(-1)!;
    expect(picker2['hint']).toBe(
      t('knowledge.menu_hint') + ' · ' + t('kw.embedding_failed') + t('kw.embedding_data_intact'),
    );
  });
});

// ─── 2. ingest 目录分支：formatProgress 9-stage 映射 + failed>0 部分成功汇总 ───

describe('handleKnowledgeCommand — ingest 目录', () => {
  it('9 种进度 stage 精确映射 spinner 标签；failed>0 时走 batch_partial 汇总（含文件名与覆盖率）', async () => {
    const store = makeStore({ embeddingCoverage: vi.fn(async () => ({ embedded: 2, total: 5 })) });
    vi.mocked(knowledgeStore.getKnowledgeStore).mockResolvedValue(store as never);

    const stages: IngestProgress[] = [
      { stage: 'embedding-check', message: 'MSG-check' },
      { stage: 'chunking', message: 'MSG-ignored-by-mapping' },
      { stage: 'embedding-chunks', chunkIndex: 2, totalChunks: 5, message: 'x' },
      { stage: 'extracting', chunkIndex: 3, totalChunks: 5, message: 'x' },
      { stage: 'embedding-events', chunkIndex: 4, totalChunks: 5, message: 'x' },
      { stage: 'embedding-entities', message: 'x' },
      { stage: 'embedding-relations', message: 'x' },
      { stage: 'completed', message: 'MSG-done' },
      { stage: 'error', message: 'MSG-err' },
    ];

    const dirPath = await mkdtemp(join(tmpRoot, 'docs-'));
    knowledgePkg.ingestDirectory.mockImplementation(
      async (_store: unknown, llm: { generate: (s: string, u: string) => Promise<string> }, path: string, onProgress?: (p: IngestProgress) => void) => {
        expect(_store).toBe(store);
        expect(path).toBe(dirPath);
        expect(await llm.generate('sys', 'usr')).toBe('llm-ok');
        for (const s of stages) onProgress?.(s);
        return {
          succeeded: 1,
          failed: 1,
          created: 1,
          updated: 0,
          unchanged: 0,
          totalChunks: 3,
          totalEvents: 2,
          totalEntities: 4,
          errors: [{ filePath: '/tmp/docs/bad.docx', message: 'internal boom' }],
        };
      },
    );

    const { host, spinner, generateText } = makeHost();
    await openMenu(host);
    await selectMenuAction('ingest');
    expect(dialogs.inputs).toHaveLength(1);
    await submitPath(dirPath);

    // formatProgress 全 9 stage 映射：message 透传（embedding-check/completed）、
    // error 走 knowledge.error 插值、chunking 忽略 message、带 index/total 的三种各自插值。
    expect(spinner.setLabel.mock.calls.map((c) => c[0])).toEqual([
      'MSG-check',
      t('knowledge.chunking'),
      t('knowledge.embedding_chunks', { index: '2', total: '5' }),
      t('knowledge.extracting', { index: '3', total: '5' }),
      t('knowledge.embedding_events', { index: '4', total: '5' }),
      t('knowledge.embedding_entities'),
      t('knowledge.embedding_relations'),
      'MSG-done',
      t('knowledge.error', { msg: 'MSG-err' }),
    ]);
    // llm caller 直通 session.generateText
    expect(generateText).toHaveBeenCalledWith('sys', 'usr');

    // failed>0 → stop 标红 + 部分成功汇总
    expect(spinner.stop).toHaveBeenCalledWith({ ok: false, label: t('knowledge.batch_done') });
    expect(host.showNotice).toHaveBeenCalledTimes(1);
    const [title, summary] = vi.mocked(host.showNotice).mock.calls[0]!;
    expect(title).toBe(t('knowledge.batch_partial'));
    expect(summary).toContain(t('knowledge.succeeded', { count: '1' }));
    expect(summary).toContain(t('knowledge.failed', { count: '1' }));
    expect(summary).toContain('bad.docx: internal boom'); // basename(e.filePath)
    expect(summary).toContain(
      t('knowledge.vector_coverage', { embedded: '2', total: '5' }),
    );
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('全成功目录批次走 batch_done 汇总而非 batch_partial', async () => {
    const store = makeStore({ embeddingCoverage: vi.fn(async () => ({ embedded: 3, total: 3 })) });
    vi.mocked(knowledgeStore.getKnowledgeStore).mockResolvedValue(store as never);
    knowledgePkg.ingestDirectory.mockResolvedValue({
      succeeded: 2, failed: 0, created: 2, updated: 0, unchanged: 0,
      totalChunks: 3, totalEvents: 1, totalEntities: 2, errors: [],
    } as never);

    const dirPath = await mkdtemp(join(tmpRoot, 'docs-ok-'));
    const { host, spinner } = makeHost();
    await openMenu(host);
    await selectMenuAction('ingest');
    await submitPath(dirPath);

    expect(spinner.stop).toHaveBeenCalledWith({ ok: true, label: t('knowledge.batch_done') });
    const [title, body] = vi.mocked(host.showNotice).mock.calls[0]!;
    expect(title).toBe(t('knowledge.batch_done'));
    expect(body).toContain('3 chunks, 1 events, 2 entities');
    expect(body).toContain(t('knowledge.vector_coverage', { embedded: '3', total: '3' }));
  });
});

// ─── 3. ingest 前置输入分支：取消 / 空路径 / 路径不存在 ─────────────

describe('handleKnowledgeCommand — ingest 输入校验', () => {
  it('对话框取消则直接返回；空白路径报 path_empty；不存在路径报 path_not_exist；三者都不触达 store', async () => {
    // 取消
    let { host } = makeHost();
    await openMenu(host);
    await selectMenuAction('ingest');
    lastInput().onDone({ kind: 'cancel' });
    await flush();
    expect(host.showProgressSpinner).not.toHaveBeenCalled();
    expect(knowledgeStore.getKnowledgeStore).not.toHaveBeenCalled();

    // 空白路径
    ({ host } = makeHost());
    await openMenu(host);
    await selectMenuAction('ingest');
    await submitPath('   ');
    expect(host.showError).toHaveBeenCalledWith(t('error.path_empty'));
    expect(knowledgeStore.getKnowledgeStore).not.toHaveBeenCalled();

    // 不存在路径（真实 stat 抛 ENOENT）
    ({ host } = makeHost());
    await openMenu(host);
    await selectMenuAction('ingest');
    const missing = join(tmpRoot, 'no-such-knowledge-path');
    await submitPath(missing);
    expect(host.showError).toHaveBeenCalledWith(t('error.path_not_exist', { path: missing }));
    expect(knowledgeStore.getKnowledgeStore).not.toHaveBeenCalled();
  });
});

// ─── 4. ingest 文件分支：不支持格式 / created / unchanged ───────────

describe('handleKnowledgeCommand — ingest 文件', () => {
  async function makeFilePath(name = 'note.md'): Promise<string> {
    const file = join(tmpRoot, name);
    await writeFile(file, '# hello\n');
    return file;
  }

  it('不支持的文件格式：spinner 标红失败 + showError，且不调用 ingestFile', async () => {
    vi.mocked(knowledgeStore.getKnowledgeStore).mockResolvedValue(makeStore() as never);
    vi.mocked(knowledgePkg.isSupportedFile).mockReturnValue(false);
    const file = await makeFilePath('image.png');

    const { host, spinner } = makeHost();
    await openMenu(host);
    await selectMenuAction('ingest');
    await submitPath(file);

    expect(spinner.stop).toHaveBeenCalledWith({ ok: false, label: t('error.unsupported_format') });
    expect(host.showError).toHaveBeenCalledWith(t('error.unsupported_format'));
    expect(knowledgePkg.ingestFile).not.toHaveBeenCalled();
  });

  it('created 结果：ingest_done 汇总含 chunk/event/entity 计数与向量覆盖率', async () => {
    const store = makeStore({ embeddingCoverage: vi.fn(async () => ({ embedded: 2, total: 2 })) });
    vi.mocked(knowledgeStore.getKnowledgeStore).mockResolvedValue(store as never);
    knowledgePkg.ingestFile.mockResolvedValue({
      documentId: 'doc-1', chunkCount: 2, eventCount: 1, entityCount: 3, outcome: 'created',
    } as never);
    const file = await makeFilePath();

    const { host, spinner } = makeHost();
    await openMenu(host);
    await selectMenuAction('ingest');
    await submitPath(file);

    expect(spinner.stop).toHaveBeenCalledWith({ ok: true, label: t('knowledge.ingest_done') });
    const [title, body] = vi.mocked(host.showNotice).mock.calls[0]!;
    expect(title).toBe(t('knowledge.ingest_done'));
    expect(body).toContain(t('knowledge.file_label') + ': note.md');
    expect(body).toContain('chunks: 2');
    expect(body).toContain('events: 1');
    expect(body).toContain('entities: 3');
    expect(body).toContain(t('knowledge.vector_coverage', { embedded: '2', total: '2' }));
  });

  it('unchanged 结果：仅显示文件名，不查询覆盖率；updated 走 updated 文案', async () => {
    const store = makeStore();
    vi.mocked(knowledgeStore.getKnowledgeStore).mockResolvedValue(store as never);
    knowledgePkg.ingestFile.mockResolvedValue({
      documentId: 'doc-1', chunkCount: 0, eventCount: 0, entityCount: 0, outcome: 'unchanged',
    } as never);
    const file = await makeFilePath('same.md');

    const { host } = makeHost();
    await openMenu(host);
    await selectMenuAction('ingest');
    await submitPath(file);

    const [title, body] = vi.mocked(host.showNotice).mock.calls[0]!;
    expect(title).toBe(t('knowledge.ingest_unchanged'));
    expect(body).toBe(`${t('knowledge.file_label')}: same.md`);
    expect(store.embeddingCoverage).not.toHaveBeenCalled();

    // updated 标签映射
    knowledgePkg.ingestFile.mockResolvedValue({
      documentId: 'doc-2', chunkCount: 1, eventCount: 0, entityCount: 0, outcome: 'updated',
    } as never);
    vi.mocked(host.showNotice).mockClear();
    await selectMenuAction('ingest');
    await submitPath(file);
    expect(vi.mocked(host.showNotice).mock.calls[0]![0]).toBe(t('knowledge.ingest_updated'));
  });
});

// ─── 5. ensureEmbeddingReadyInteractive 三门闸 ──────────────────────

describe('handleKnowledgeCommand — embedding 就绪门闸', () => {
  async function driveIngestToGate(host: SlashCommandHost, dirPath: string) {
    await openMenu(host);
    await selectMenuAction('ingest');
    await submitPath(dirPath);
  }

  it('门闸 1：engine 已 available → 不打扰用户，直接进入摄取', async () => {
    vi.mocked(knowledgeStore.getKnowledgeStore).mockResolvedValue(makeStore() as never);
    knowledgePkg.ingestDirectory.mockResolvedValue({
      succeeded: 1, failed: 0, created: 1, updated: 0, unchanged: 0,
      totalChunks: 0, totalEvents: 0, totalEntities: 0, errors: [],
    } as never);
    const dir = await mkdtemp(join(tmpRoot, 'gate-ok-'));
    const { host } = makeHost();
    await driveIngestToGate(host, dir);

    expect(knowledgeStore.isEmbeddingModelCached).not.toHaveBeenCalled();
    expect(knowledgeStore.startManualEmbeddingDownload).not.toHaveBeenCalled();
    expect(knowledgePkg.ingestDirectory).toHaveBeenCalledTimes(1);
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('门闸 2：模型未缓存 → showError(model_missing) 且不建摄取 spinner', async () => {
    vi.mocked(knowledgeStore.getKnowledgeStore).mockResolvedValue(
      makeStore({ getEmbeddingEngine: vi.fn(() => ({ available: false })) }) as never,
    );
    vi.mocked(knowledgeStore.isEmbeddingModelCached).mockReturnValue(false);
    const dir = await mkdtemp(join(tmpRoot, 'gate-nocache-'));
    const { host } = makeHost();
    await driveIngestToGate(host, dir);

    expect(host.showError).toHaveBeenCalledWith(t('knowledge.model_missing'));
    expect(knowledgeStore.startManualEmbeddingDownload).not.toHaveBeenCalled();
    expect(knowledgePkg.ingestDirectory).not.toHaveBeenCalled();
    expect(host.showProgressSpinner).not.toHaveBeenCalled(); // gate 在 spinner 之前
  });

  it('门闸 3：模型已缓存但加载失败 → model_load_failed notice 含重试提示与原始错误；加载成功则继续摄取', async () => {
    const engineNotReady = { available: false };
    vi.mocked(knowledgeStore.getKnowledgeStore).mockResolvedValue(
      makeStore({ getEmbeddingEngine: vi.fn(() => engineNotReady) }) as never,
    );
    knowledgeStore.startManualEmbeddingDownload.mockResolvedValueOnce({ ok: false, error: 'HTTP 503' } as never);
    const dir = await mkdtemp(join(tmpRoot, 'gate-load-'));

    const { host } = makeHost();
    await driveIngestToGate(host, dir);

    expect(host.showNotice).toHaveBeenCalledWith(
      t('knowledge.model_load_failed'),
      `${t('knowledge.download_model_retry_hint')}\nHTTP 503`,
    );
    expect(knowledgePkg.ingestDirectory).not.toHaveBeenCalled();

    // 第二次：加载成功 → 摄取继续（loading_model spinner 也出现过）
    knowledgePkg.ingestDirectory.mockResolvedValue({
      succeeded: 1, failed: 0, created: 1, updated: 0, unchanged: 0,
      totalChunks: 0, totalEvents: 0, totalEntities: 0, errors: [],
    } as never);
    knowledgeStore.startManualEmbeddingDownload.mockResolvedValueOnce({ ok: true } as never);
    const { host: host2 } = makeHost();
    await driveIngestToGate(host2, dir);
    expect(host2.showProgressSpinner).toHaveBeenCalledWith(t('knowledge.loading_model'));
    expect(knowledgeStore.startManualEmbeddingDownload).toHaveBeenCalled();
    expect(knowledgePkg.ingestDirectory).toHaveBeenCalledTimes(1);
    expect(host2.showError).not.toHaveBeenCalled();
  });
});

// ─── 6. handleDelete 三态 ───────────────────────────────────────────

describe('handleKnowledgeCommand — delete', () => {
  const sourceA = { id: 'src-a', name: 'Doc A', filePath: '/docs/a.md' };

  it('空列表 → notice，不弹选择器', async () => {
    vi.mocked(knowledgeStore.getKnowledgeStore).mockResolvedValue(makeStore() as never);
    const { host } = makeHost();
    await openMenu(host);
    await selectMenuAction('delete');

    expect(host.showNotice).toHaveBeenCalledWith(t('knowledge.empty'), t('knowledge.no_delete'));
    expect(dialogs.pickers).toHaveLength(2); // 菜单动作完成后总会重弹（只有 notice，无中间选择器）
  });

  it('取消确认 → cancelled notice 且 deleteSource 不被调用', async () => {
    const store = makeStore({ listSources: vi.fn(async () => [sourceA]) });
    vi.mocked(knowledgeStore.getKnowledgeStore).mockResolvedValue(store as never);
    const { host } = makeHost();
    await openMenu(host);
    await selectMenuAction('delete');

    // 选择器 2 = 源列表；选项带 danger tone 与 filePath 描述
    const sourcePicker = dialogs.pickers.at(-1)!;
    expect(sourcePicker['options']).toEqual([
      { value: 'src-a', label: 'Doc A', description: '/docs/a.md', tone: 'danger' },
    ]);
    (sourcePicker['onSelect'] as (v: string) => void)('src-a');
    await flush();

    // 选择器 3 = 确认框（cancel / confirm 两项）
    const confirmPicker = dialogs.pickers.at(-1)!;
    expect((confirmPicker['options'] as Array<{ value: string }>).map((o) => o.value)).toEqual([
      'cancel',
      'confirm',
    ]);
    (confirmPicker['onCancel'] as () => void)();
    await flush();

    expect(host.showNotice).toHaveBeenCalledWith(t('knowledge.cancelled'), t('knowledge.no_delete'));
    expect(store.deleteSource).not.toHaveBeenCalled();
  });

  it('确认后 deleteSource 返回 false → error；返回 true → deleted notice', async () => {
    const store = makeStore({
      listSources: vi.fn(async () => [sourceA]),
      deleteSource: vi.fn(async () => false),
    });
    vi.mocked(knowledgeStore.getKnowledgeStore).mockResolvedValue(store as never);
    const { host } = makeHost();
    await openMenu(host);
    await selectMenuAction('delete');
    (dialogs.pickers.at(-1)!['onSelect'] as (v: string) => void)('src-a');
    await flush();
    (dialogs.pickers.at(-1)!['onSelect'] as (v: string) => void)('confirm');
    await flush();

    expect(store.deleteSource).toHaveBeenCalledWith('src-a');
    expect(host.showError).toHaveBeenCalledWith(t('knowledge.delete_fail_not_found'));
    expect(host.showNotice).not.toHaveBeenCalled();

    // 成功分支
    store.deleteSource.mockResolvedValueOnce(true);
    await selectMenuAction('delete');
    (dialogs.pickers.at(-1)!['onSelect'] as (v: string) => void)('src-a');
    await flush();
    (dialogs.pickers.at(-1)!['onSelect'] as (v: string) => void)('confirm');
    await flush();
    expect(host.showNotice).toHaveBeenCalledWith(t('knowledge.deleted'), t('knowledge.doc_removed'));
  });
});

// ─── 7. 菜单循环：动作后回菜单 / 异常兜底 / 取消退出 / web 分派 ─────

describe('handleKnowledgeCommand — 菜单循环', () => {
  it('stats 动作完成后重新弹出菜单', async () => {
    const store = makeStore({
      stats: vi.fn(async () => ({ sources: 3, documents: 5, chunks: 7, events: 9, entities: 11 })),
    });
    vi.mocked(knowledgeStore.getKnowledgeStore).mockResolvedValue(store as never);
    const { host } = makeHost();
    await openMenu(host);
    await selectMenuAction('stats');

    expect(dialogs.viewers).toHaveLength(1);
    const viewer = dialogs.viewers[0]!;
    expect(viewer['title']).toBe(t('knowledge.stats'));
    expect(viewer['content']).toContain('sources:   3');
    expect(viewer['content']).toContain('entities:  11');

    (viewer['onClose'] as () => void)();
    await flush();
    expect(dialogs.pickers).toHaveLength(2); // 菜单回来了
    expect(host.restoreEditor).toHaveBeenCalled();
  });

  it('动作抛异常 → showError(op_failed) 且菜单仍会重新弹出', async () => {
    const store = makeStore({ listSources: vi.fn(async () => { throw new Error('boom'); }) });
    vi.mocked(knowledgeStore.getKnowledgeStore).mockResolvedValue(store as never);
    const { host } = makeHost();
    await openMenu(host);
    await selectMenuAction('delete');

    expect(host.showError).toHaveBeenCalledWith(t('knowledge.op_failed', { msg: 'boom' }));
    expect(dialogs.pickers).toHaveLength(2); // catch 后仍 showMenu
  });

  it('菜单取消 → restoreEditor 且不再弹菜单；选 web → 分派 handleWeb 后菜单回归', async () => {
    const { host } = makeHost();
    await openMenu(host);

    // web 分派（knowledge-web 已 mock，不起真 server）
    await selectMenuAction('web');
    expect(webMock.handleWeb).toHaveBeenCalledWith(host);
    expect(dialogs.pickers).toHaveLength(2);

    (dialogs.pickers.at(-1)!['onCancel'] as () => void)();
    await flush();
    expect(host.restoreEditor).toHaveBeenCalled();
    expect(dialogs.pickers).toHaveLength(2); // 取消即退出循环
  });
});

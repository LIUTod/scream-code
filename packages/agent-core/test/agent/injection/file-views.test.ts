import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { ContextMessage } from '../../../src/agent/context/types';
import { ChangedFilesInjector, RestoredFilesInjector } from '../../../src/agent/injection/file-views';
import { computeAnchor } from '../../../src/tools/builtin/file/line-endings';
import { EditSnapshotStore } from '../../../src/tools/support/edit-snapshot-store';

interface Disk {
  files: Map<string, { text: string; mtime: number }>;
}

function makeAgent(disk: Disk, store: EditSnapshotStore, history: ContextMessage[] = []): Agent {
  return {
    editSnapshots: store,
    config: { cwd: '/w', modelCapabilities: { max_context_tokens: 200_000 } },
    jian: {
      stat: async (path: string) => {
        const file = disk.files.get(path);
        if (file === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return { stMtime: file.mtime, stSize: Buffer.byteLength(file.text) };
      },
      readText: async (path: string) => {
        const file = disk.files.get(path);
        if (file === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return file.text;
      },
    },
    context: {
      history,
      appendSystemReminder: (content: string) => {
        history.push({ role: 'user', content: [{ type: 'text', text: content }], toolCalls: [] });
      },
    },
  } as unknown as Agent;
}

const view = (text: string) => ({ content: text, anchor: computeAnchor(text), recordedAt: 'read' as const });
const lastText = (history: ContextMessage[]): string => {
  const part = history.at(-1)?.content[0];
  return part?.type === 'text' ? part.text : '';
};

describe('ChangedFilesInjector', () => {
  it('says nothing while files hold what the model last saw', async () => {
    const disk: Disk = { files: new Map([['/w/a.ts', { text: 'one\ntwo\n', mtime: 1 }]]) };
    const store = new EditSnapshotStore();
    store.remember('/w/a.ts', view('one\ntwo\n'));
    const history: ContextMessage[] = [];
    const injector = new ChangedFilesInjector(makeAgent(disk, store, history));

    await injector.inject();
    await injector.inject();

    expect(history).toHaveLength(0);
  });

  it('shows the lines a file changed by outside the model, numbered like Read, once', async () => {
    const disk: Disk = { files: new Map([['/w/a.ts', { text: 'one\ntwo\nthree\n', mtime: 1 }]]) };
    const store = new EditSnapshotStore();
    store.remember('/w/a.ts', view('one\ntwo\nthree\n'));
    const history: ContextMessage[] = [];
    const injector = new ChangedFilesInjector(makeAgent(disk, store, history));
    await injector.inject();

    disk.files.set('/w/a.ts', { text: 'one\nTWO\nthree\n', mtime: 2 });
    await injector.inject();

    expect(history).toHaveLength(1);
    expect(lastText(history)).toContain('a.ts changed');
    expect(lastText(history)).toContain('2\tTWO');
    // The new text is now the known view: later edits are not refused over it.
    expect(store.recall('/w/a.ts')?.content).toBe('one\nTWO\nthree\n');
    await injector.inject();
    expect(history).toHaveLength(1);
  });

  it('reports a file that was deleted and stops tracking it', async () => {
    const disk: Disk = { files: new Map() };
    const store = new EditSnapshotStore();
    store.remember('/w/gone.ts', view('x\n'));
    const history: ContextMessage[] = [];
    await new ChangedFilesInjector(makeAgent(disk, store, history)).inject();

    expect(lastText(history)).toContain('gone.ts was deleted');
    expect(store.recall('/w/gone.ts')).toBeUndefined();
  });
});

describe('RestoredFilesInjector', () => {
  it('puts the files the model was working on back after a compaction, as they are now', async () => {
    const disk: Disk = {
      files: new Map([
        ['/w/a.ts', { text: 'alpha\nbeta\n', mtime: 1 }],
        ['/w/b.ts', { text: 'gamma\n', mtime: 1 }],
      ]),
    };
    const store = new EditSnapshotStore();
    store.remember('/w/a.ts', view('old alpha\n'));
    store.remember('/w/b.ts', view('gamma\n'));
    const history: ContextMessage[] = [];
    const injector = new RestoredFilesInjector(makeAgent(disk, store, history));

    // Nothing before a compaction.
    await injector.inject();
    expect(history).toHaveLength(0);

    injector.onContextCompacted(10);
    await injector.inject();

    const text = lastText(history);
    expect(text).toContain('a.ts (2 lines, anchor');
    expect(text).toContain('1\talpha');
    expect(text).toContain('b.ts (1 line, anchor');
    // The current text becomes the known view.
    expect(store.recall('/w/a.ts')?.content).toBe('alpha\nbeta\n');
    // Once per compaction.
    await injector.inject();
    expect(history).toHaveLength(1);
  });

  it('skips a file whose Read survived the compaction', async () => {
    const disk: Disk = { files: new Map([['/w/a.ts', { text: 'alpha\n', mtime: 1 }]]) };
    const store = new EditSnapshotStore();
    store.remember('/w/a.ts', view('alpha\n'));
    const history: ContextMessage[] = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'r1', name: 'Read', arguments: JSON.stringify({ path: 'a.ts' }) }],
      },
    ];
    const injector = new RestoredFilesInjector(makeAgent(disk, store, history));
    injector.onContextCompacted(3);
    await injector.inject();

    expect(history).toHaveLength(1);
  });
});

import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_GLOB_EXCLUDES,
  type GlobInput,
  GlobInputSchema,
  GlobTool,
  MAX_MATCHES,
  globExcludesForPattern,
} from '../../src/tools/builtin/file/glob';
import { scanCache } from '../../src/tools/support/scan-cache';
import type { WorkspaceConfig } from '../../src/tools/support/workspace';
import { testJian } from '../fixtures/test-jian';
import { createFakeJian } from './fixtures/fake-jian';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;
const workspace: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: ['/extra'] };

async function* asyncPaths(paths: readonly string[]) {
  for (const item of paths) yield item;
}

function stat(mtime: number, mode = 0o100000) {
  return { stMtime: mtime, stMode: mode };
}

function context(args: GlobInput) {
  return { turnId: '0', toolCallId: 'call_glob', args, signal };
}

describe('GlobTool', () => {
  beforeEach(() => {
    scanCache.clear();
  });
  it('exposes current metadata and schema', () => {
    const tool = new GlobTool(createFakeJian(), workspace);

    expect(tool.name).toBe('Glob');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { pattern: { type: 'string' } },
    });
    expect(GlobInputSchema.safeParse({ pattern: 'src/**/*.ts' }).success).toBe(true);
    expect(GlobInputSchema.safeParse({ pattern: '*.js', path: '/src' }).success).toBe(true);
  });

  it('exposes the include_dirs default in its JSON Schema without making it required', () => {
    const tool = new GlobTool(createFakeJian(), workspace);
    const schema = tool.parameters as {
      properties: { include_dirs: { default?: unknown } };
      required?: string[];
    };

    // The default must be structurally visible to the model, not only
    // described in prose, so it survives without an explicit argument.
    expect(schema.properties.include_dirs.default).toBe(true);
    // A default value must not promote include_dirs into `required`.
    expect(schema.required ?? []).not.toContain('include_dirs');
  });

  it('injects the Windows path hint into the description on a win32 backend', () => {
    const tool = new GlobTool(createFakeJian({ pathClass: () => 'win32' }), workspace);

    expect(tool.description).toContain('Windows');
    expect(tool.description).toContain('forward slashes');
    expect(tool.description).toContain('Bash');
  });

  it('omits the Windows path hint from the description on a non-Windows backend', () => {
    const tool = new GlobTool(createFakeJian({ pathClass: () => 'posix' }), workspace);

    expect(tool.description).not.toContain('forward slashes');
  });

  it('returns matching paths sorted by mtime and relative to an explicit search root', async () => {
    const glob = vi
      .fn()
      .mockReturnValue(asyncPaths(['/workspace/src/old.ts', '/workspace/src/new.ts']));
    const tool = new GlobTool(
      createFakeJian({
        glob,
        stat: vi.fn().mockResolvedValueOnce(stat(1)).mockResolvedValueOnce(stat(10)),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: 'src/**/*.ts', path: '/workspace' }));

    expect(result.output).toBe('src/new.ts\nsrc/old.ts');
    expect(glob).toHaveBeenCalledWith('/workspace', 'src/**/*.ts', {
      allowedRoots: ['/workspace'],
      exclude: DEFAULT_GLOB_EXCLUDES,
      signal,
    });
  });

  it('uses the backend path class when displaying paths relative to a windows root', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths(['C:\\workspace\\src\\old.ts']));
    const tool = new GlobTool(
      createFakeJian({
        pathClass: () => 'win32',
        glob,
        stat: vi.fn().mockResolvedValue(stat(1)),
      }),
      { workspaceDir: 'C:\\workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: 'src/**/*.ts', path: 'C:\\WORKSPACE' }));

    expect(result.output).toBe('src/old.ts');
    expect(glob).toHaveBeenCalledWith('C:/WORKSPACE', 'src/**/*.ts', {
      allowedRoots: ['C:/WORKSPACE'],
      exclude: DEFAULT_GLOB_EXCLUDES,
      signal,
    });
  });

  it('rejects pure wildcard patterns before walking the tree', async () => {
    const glob = vi.fn();
    const tool = new GlobTool(
      createFakeJian({
        glob,
        iterdir: vi.fn().mockReturnValue(asyncPaths(['/workspace/src'])),
        stat: vi.fn().mockResolvedValue(stat(0, 0o040000)),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: '**' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('pure wildcard');
    expect(result.output).toContain('/workspace');
    expect(glob).not.toHaveBeenCalled();
  });

  it('rejects brace expansion patterns with a clear split-call hint', async () => {
    const glob = vi.fn();
    const tool = new GlobTool(createFakeJian({ glob }), workspace);

    const result = await executeTool(tool, context({ pattern: '*.{ts,tsx}' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('brace expansion');
    expect(result.output).toContain('Split it into separate calls');
    expect(glob).not.toHaveBeenCalled();
  });

  it('searches only the current workspace when path is omitted', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths(['/workspace/a.ts', '/workspace/shared.ts']));
    const tool = new GlobTool(
      createFakeJian({
        glob,
        stat: vi.fn().mockResolvedValue(stat(1)),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: '*.ts' }));

    expect(glob).toHaveBeenCalledTimes(1);
    expect(glob).toHaveBeenCalledWith('/workspace', '*.ts', {
      allowedRoots: ['/workspace'],
      exclude: DEFAULT_GLOB_EXCLUDES,
      signal,
    });
    expect(result.output).toBe('a.ts\nshared.ts');
  });

  it('prunes .git and node_modules by default', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths([]));
    const tool = new GlobTool(createFakeJian({ glob }), workspace);

    await executeTool(tool, context({ pattern: 'src/**/*.ts' }));

    // The default list is pinned literally here on purpose: what the tool
    // prunes is a product decision, so changing it must be a deliberate
    // edit to this expectation as well as to DEFAULT_GLOB_EXCLUDES.
    expect(glob).toHaveBeenCalledWith('/workspace', 'src/**/*.ts', {
      allowedRoots: ['/workspace'],
      exclude: ['.git', 'node_modules'],
      signal,
    });
  });

  it('keeps a pruned name in the walk when the pattern names it explicitly', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths([]));
    const tool = new GlobTool(createFakeJian({ glob }), workspace);

    await executeTool(tool, context({ pattern: 'node_modules/react/src/**/*.js' }));

    expect(glob).toHaveBeenCalledWith('/workspace', 'node_modules/react/src/**/*.js', {
      allowedRoots: ['/workspace'],
      exclude: ['.git'],
      signal,
    });
  });

  it('can search an additional directory when path is explicit', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths(['/extra/pkg/a.ts']));
    const tool = new GlobTool(
      createFakeJian({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: 'pkg/**/*.ts', path: '/extra' }));

    expect(result.output).toBe('pkg/a.ts');
    expect(glob).toHaveBeenCalledTimes(1);
    expect(glob).toHaveBeenCalledWith('/extra', 'pkg/**/*.ts', {
      allowedRoots: ['/extra'],
      exclude: DEFAULT_GLOB_EXCLUDES,
      signal,
    });
  });

  it('filters directories when include_dirs is false', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths(['/workspace/src', '/workspace/src/a.ts']));
    const tool = new GlobTool(
      createFakeJian({
        glob,
        stat: vi
          .fn()
          .mockResolvedValueOnce(stat(2, 0o040000))
          .mockResolvedValueOnce(stat(1, 0o100000)),
      }),
      workspace,
    );

    const result = await executeTool(tool,
      context({ pattern: 'src*', path: '/workspace', include_dirs: false }),
    );

    expect(result.output).toBe('src/a.ts');
  });

  it('caps returned matches and surfaces the truncation header', async () => {
    const paths = Array.from({ length: MAX_MATCHES + 1 }, (_, i) => `/workspace/${String(i)}.ts`);
    const tool = new GlobTool(
      createFakeJian({
        glob: vi.fn().mockReturnValue(asyncPaths(paths)),
        stat: vi.fn().mockResolvedValue(stat(1)),
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: '*.ts' }));

    expect(result.output).toContain(`[Truncated at ${String(MAX_MATCHES)} matches`);
    expect(result.output).toContain('0.ts');
    expect(result.output).not.toContain(`${String(MAX_MATCHES)}.ts`);
  });

  describe('skills / additional dirs', () => {
    const skillsWorkspace: WorkspaceConfig = {
      workspaceDir: '/workspace',
      additionalDirs: ['/skills'],
    };

    it('searches inside a registered additionalDir entry', async () => {
      const glob = vi
        .fn()
        .mockReturnValue(asyncPaths(['/skills/read_content.py', '/skills/utils.py']));
      const tool = new GlobTool(
        createFakeJian({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
        skillsWorkspace,
      );

      const result = await executeTool(tool, context({ pattern: '*.py', path: '/skills' }));

      expect(result.output).toContain('read_content.py');
      expect(result.output).toContain('utils.py');
      expect(glob).toHaveBeenCalledWith('/skills', '*.py', {
        allowedRoots: ['/skills'],
        exclude: DEFAULT_GLOB_EXCLUDES,
        signal,
      });
    });

    it('searches inside a subdirectory of an additionalDir entry', async () => {
      const glob = vi
        .fn()
        .mockReturnValue(asyncPaths(['/skills/feishu/scripts/read_content.py']));
      const tool = new GlobTool(
        createFakeJian({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
        skillsWorkspace,
      );

      const result = await executeTool(tool,
        context({ pattern: '*.py', path: '/skills/feishu/scripts' }),
      );

      expect(result.output).toContain('read_content.py');
    });

    it('rejects a relative path that escapes both workspace and additionalDirs', async () => {
      const glob = vi.fn();
      const tool = new GlobTool(createFakeJian({ glob }), {
        workspaceDir: '/workspace/project',
        additionalDirs: ['/skills'],
      });

      const result = await executeTool(tool, context({ pattern: '*.py', path: '../../tmp/evil' }));

      expect(result).toMatchObject({ isError: true });
      expect(result.output).toContain('absolute path');
      expect(glob).not.toHaveBeenCalled();
    });

    it('accepts a path inside a deeply nested additionalDir entry', async () => {
      const glob = vi
        .fn()
        .mockReturnValue(asyncPaths(['/skills/my-skill/scripts/helper.py']));
      const tool = new GlobTool(
        createFakeJian({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
        skillsWorkspace,
      );

      const result = await executeTool(tool,
        context({ pattern: '*.py', path: '/skills/my-skill/scripts' }),
      );

      expect(result.output).toContain('helper.py');
    });
  });

  it('rejects "**/" prefix patterns even with a literal anchor', async () => {
    // py rejects every pattern starting with "**/". TS only rejects pure-
    // wildcard patterns and accepts "**/*.py" because the `.py` literal
    // anchors the walk. Test as a lockdown of the py contract — expected
    // to fail under the current TS policy.
    const glob = vi.fn();
    const tool = new GlobTool(
      createFakeJian({
        glob,
        iterdir: vi.fn().mockReturnValue(asyncPaths([])),
        stat: vi.fn().mockResolvedValue(stat(0, 0o040000)),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: '**/*.py' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toMatch(/starts with '\*\*' which is not allowed/);
  });

  it('walks safe recursive patterns with a literal subdirectory anchor', async () => {
    const glob = vi.fn().mockReturnValue(
      asyncPaths([
        '/workspace/src/main.py',
        '/workspace/src/utils.py',
        '/workspace/src/main/app.py',
        '/workspace/src/main/config.py',
        '/workspace/src/test/test_app.py',
        '/workspace/src/test/test_config.py',
      ]),
    );
    const tool = new GlobTool(
      createFakeJian({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: 'src/**/*.py', path: '/workspace' }));

    expect(result.output).toContain('src/main.py');
    expect(result.output).toContain('src/utils.py');
    expect(result.output).toContain('src/main/app.py');
    expect(result.output).toContain('src/main/config.py');
    expect(result.output).toContain('src/test/test_app.py');
    expect(result.output).toContain('src/test/test_config.py');
  });

  it('surfaces an explicit no-match message when no paths are yielded', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths([]));
    const tool = new GlobTool(createFakeJian({ glob }), workspace);

    const result = await executeTool(tool, context({ pattern: '*.xyz', path: '/workspace' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('No matches found');
  });

  it('forwards the execution signal and a one-entry budget into the pre-check iterdir', async () => {
    // The existence probe pulls exactly one entry; forwarding the signal ties
    // the probe to the tool call's cancellation and maxEntries pins its budget
    // to that single entry.
    const controller = new AbortController();
    const iterdirCalls: Array<{ signal?: AbortSignal; maxEntries?: number } | undefined> = [];
    const iterdir = vi.fn(
      (_path: string, options?: { signal?: AbortSignal; maxEntries?: number }) => {
        iterdirCalls.push(options);
        return asyncPaths(['/workspace/src']);
      },
    );
    const glob = vi.fn().mockReturnValue(asyncPaths([]));
    const tool = new GlobTool(createFakeJian({ iterdir, glob }), workspace);

    const result = await executeTool(tool, {
      ...context({ pattern: '*.ts' }),
      signal: controller.signal,
    });

    expect(result.output).toContain('No matches found');
    expect(iterdirCalls).toEqual([{ signal: controller.signal, maxEntries: 1 }]);
  });

  it('forwards the execution signal into the listing iterdir calls on the rejection path', async () => {
    // The "**/" rejection renders a workspace listing through listDirectory;
    // its iterdir walks (root level and one child) must carry the same signal
    // so an abandoned call stops listing too.
    const controller = new AbortController();
    const iterdirCalls: Array<{ signal?: AbortSignal; maxEntries?: number } | undefined> = [];
    const iterdir = vi.fn(
      (path: string, options?: { signal?: AbortSignal; maxEntries?: number }) => {
        iterdirCalls.push(options);
        return path === '/workspace' ? asyncPaths(['/workspace/src']) : asyncPaths([]);
      },
    );
    const glob = vi.fn();
    const tool = new GlobTool(
      createFakeJian({
        iterdir,
        glob,
        stat: vi.fn().mockResolvedValue(stat(0, 0o040000)),
      }),
      workspace,
    );

    const result = await executeTool(tool, {
      ...context({ pattern: '**/*.py' }),
      signal: controller.signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(glob).not.toHaveBeenCalled();
    expect(iterdirCalls).toEqual([{ signal: controller.signal }, { signal: controller.signal }]);
  });

  it('reports "does not exist" when the search directory is missing', async () => {
    // Real jian.glob silently returns empty for a missing root because
    // its _globWalk catches readdir failures. The tool now pre-checks
    // with iterdir so ENOENT surfaces before glob runs. Realistic mock:
    // iterdir throws ENOENT, glob is never called.
    const iterdir = vi.fn(async function* (): AsyncGenerator<string> {
      await Promise.resolve();
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      yield ''; // eslint-disable-line no-unreachable -- satisfies require-yield
    });
    const glob = vi.fn();
    const tool = new GlobTool(createFakeJian({ iterdir, glob }), workspace);

    const result = await executeTool(tool,
      context({ pattern: '*.py', path: '/workspace/nonexistent' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('does not exist');
    expect(glob).not.toHaveBeenCalled();
  });

  it('reports "is not a directory" when the search target is a file', async () => {
    // Real jian.glob silently returns empty when the root is a regular
    // file because its _globWalk's readdir hits ENOTDIR and exits. The
    // pre-check uses iterdir, which raises ENOTDIR on file-as-dir.
    // Realistic mock: iterdir throws ENOTDIR, glob is never called.
    const iterdir = vi.fn(async function* (): AsyncGenerator<string> {
      await Promise.resolve();
      throw Object.assign(new Error('ENOTDIR: not a directory'), { code: 'ENOTDIR' });
      yield ''; // eslint-disable-line no-unreachable -- satisfies require-yield
    });
    const glob = vi.fn();
    const tool = new GlobTool(createFakeJian({ iterdir, glob }), workspace);

    const result = await executeTool(tool, context({ pattern: '*.py', path: '/workspace/file.txt' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('is not a directory');
    expect(glob).not.toHaveBeenCalled();
  });

  it('surfaces a "first N matches" header when matches exceed MAX_MATCHES', async () => {
    const paths = Array.from(
      { length: MAX_MATCHES + 50 },
      (_, i) => `/workspace/file_${String(i)}.txt`,
    );
    const tool = new GlobTool(
      createFakeJian({
        glob: vi.fn().mockReturnValue(asyncPaths(paths)),
        stat: vi.fn().mockResolvedValue(stat(1)),
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: '*.txt' }));

    expect(result.output).toContain(`Only the first ${String(MAX_MATCHES)} matches are returned`);
  });

  it('includes a directory listing in the rejection message for "**/" patterns', async () => {
    // py rejection includes the top-level directory listing as a hint.
    const iterdir = vi
      .fn()
      .mockReturnValue(asyncPaths(['/workspace/file1.txt', '/workspace/file2.py', '/workspace/src', '/workspace/docs']));
    const glob = vi.fn();
    const tool = new GlobTool(
      createFakeJian({
        glob,
        iterdir,
        stat: vi.fn().mockResolvedValue(stat(0, 0o100000)),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: '**/*.txt' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toMatch(/starts with '\*\*' which is not allowed/);
    expect(result.output).toContain('Use more specific patterns instead');
    expect(result.output).toContain('file1.txt');
    expect(result.output).toContain('file2.py');
    expect(result.output).toContain('src');
    expect(result.output).toContain('docs');
  });

  it('returns a "Found N matches" footer at exactly MAX_MATCHES without truncation', async () => {
    const paths = Array.from(
      { length: MAX_MATCHES },
      (_, i) => `/workspace/test_${String(i)}.py`,
    );
    const tool = new GlobTool(
      createFakeJian({
        glob: vi.fn().mockReturnValue(asyncPaths(paths)),
        stat: vi.fn().mockResolvedValue(stat(1)),
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: '*.py' }));

    expect(result.output).not.toContain('Only the first');
    expect(result.output).toContain(`Found ${String(MAX_MATCHES)} matches`);
  });

  it('rejects "**/" patterns with literal subdirectory anchors after the prefix', async () => {
    const glob = vi.fn();
    const tool = new GlobTool(
      createFakeJian({
        glob,
        iterdir: vi.fn().mockReturnValue(asyncPaths([])),
        stat: vi.fn().mockResolvedValue(stat(0, 0o040000)),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: '**/main/*.py' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toMatch(/starts with '\*\*' which is not allowed/);
    expect(glob).not.toHaveBeenCalled();
  });

  it('matches dotfiles like .gitlab-ci.yml under a simple "*.yml" pattern', async () => {
    const glob = vi
      .fn()
      .mockReturnValue(asyncPaths(['/workspace/.gitlab-ci.yml', '/workspace/config.yml']));
    const tool = new GlobTool(
      createFakeJian({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: '*.yml' }));

    expect(result.output).toContain('.gitlab-ci.yml');
    expect(result.output).toContain('config.yml');
  });

  it('descends into hidden directories under a recursive pattern', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths(['/workspace/src/.config/settings.yml']));
    const tool = new GlobTool(
      createFakeJian({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: 'src/**/*.yml' }));

    expect(result.output).toContain('src/.config/settings.yml');
  });

  it('matches files inside an explicitly addressed hidden directory', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths(['/workspace/.github/workflows/ci.yml']));
    const tool = new GlobTool(
      createFakeJian({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: '.github/**/*.yml' }));

    expect(result.output).toContain('.github/workflows/ci.yml');
  });

  it('picks up a freshly appended additionalDir without rebuilding the tool', async () => {
    // TS Glob runs with the `absolute-outside-allowed` policy, so an absolute
    // path outside the workspace is accepted even before it is registered in
    // additionalDirs. The glob walker just yields nothing for an unregistered
    // root until the underlying directory actually exists and matches.
    const additionalDirs: string[] = [];
    const mutable: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs };
    const glob = vi.fn((root: string) =>
      asyncPaths(root === '/extra' ? ['/extra/test.py'] : []),
    );
    const tool = new GlobTool(
      createFakeJian({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
      mutable,
    );

    const before = await executeTool(tool, context({ pattern: '*.py', path: '/extra' }));
    expect(before.isError).toBeFalsy();

    additionalDirs.push('/extra');

    const after = await executeTool(tool, context({ pattern: '*.py', path: '/extra' }));
    expect(after.isError).toBeFalsy();
    expect(after.output).toContain('test.py');
  });

  it('resolves a relative path argument against the workspace cwd', async () => {
    // `absolute-outside-allowed` resolves relative paths against the workspace
    // cwd. A relative path that canonicalizes inside the workspace is accepted
    // (no "not an absolute path" error); the glob walker simply yields
    // whatever matches under the resolved root.
    const glob = vi.fn().mockReturnValue(asyncPaths([]));
    const tool = new GlobTool(
      createFakeJian({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: '*.py', path: 'relative/path' }));

    expect(result.isError).toBeFalsy();
    expect(glob).toHaveBeenCalledWith('/workspace/relative/path', '*.py', {
      allowedRoots: ['/workspace/relative/path'],
      exclude: DEFAULT_GLOB_EXCLUDES,
      signal,
    });
  });

  it('expands a leading "~/" path before applying the workspace guard', async () => {
    // `~/` is expanded to the home dir, which is absolute. Under
    // `absolute-outside-allowed`, an absolute path outside the workspace is
    // accepted — so the tool proceeds and the glob walker runs against
    // `/home/test`. The key invariant: tilde expansion happens BEFORE the
    // absolute-path check, so the user never sees a misleading "not an
    // absolute path" error.
    const glob = vi.fn().mockReturnValue(asyncPaths([]));
    const tool = new GlobTool(
      createFakeJian({ glob, gethome: () => '/home/test', stat: vi.fn().mockResolvedValue(stat(1)) }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: '*.py', path: '~/' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain('not an absolute path');
    expect(glob).toHaveBeenCalledWith('/home/test', '*.py', {
      allowedRoots: ['/home/test'],
      exclude: DEFAULT_GLOB_EXCLUDES,
      signal,
    });
  });

  it('accepts a path sharing the workspace prefix but outside it', async () => {
    // `absolute-outside-allowed` accepts any absolute path, including one that
    // shares a prefix with the workspace but is actually outside it. The
    // shared-prefix escape is blocked by `isWithinDirectory`'s separator
    // requirement at the policy layer; once past that, the glob walker runs.
    const glob = vi.fn().mockReturnValue(asyncPaths([]));
    const tool = new GlobTool(
      createFakeJian({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
      { workspaceDir: '/parent/workdir', additionalDirs: [] },
    );

    const result = await executeTool(tool,
      context({ pattern: '*.py', path: '/parent/workdir-sneaky' }),
    );

    expect(result.isError).toBeFalsy();
    expect(glob).toHaveBeenCalledWith('/parent/workdir-sneaky', '*.py', {
      allowedRoots: ['/parent/workdir-sneaky'],
      exclude: DEFAULT_GLOB_EXCLUDES,
      signal,
    });
  });

  it('locks down rejection phrasing and large-directory caveats in the description', () => {
    const tool = new GlobTool(createFakeJian(), workspace);

    expect(tool.description).toContain('**');
    expect(tool.description).toMatch(/\*\*\/\*\.py/);
    expect(tool.description).toContain('node_modules');
    expect(tool.description).not.toContain('On Windows');
  });

  it('respects abort signal during enumeration via heartbeat checks', async () => {
    const controller = new AbortController();
    const paths = Array.from({ length: 300 }, (_, i) => `/workspace/src/file-${i}.ts`);
    const glob = vi.fn().mockReturnValue(asyncPaths(paths));
    const tool = new GlobTool(
      createFakeJian({
        glob,
        stat: vi.fn().mockResolvedValue(stat(1)),
      }),
      workspace,
    );

    controller.abort();

    // AbortError is re-thrown (not swallowed into a generic error result) so
    // the tool runtime can route it to abortedToolOutput with "do not retry"
    // semantics.
    await expect(
      executeTool(tool, {
        ...context({ pattern: 'src/**/*.ts' }),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it('stops a cancelled zero-match scan instead of reporting "No matches found"', async () => {
    // The 128-yield heartbeat above cannot fire for a pattern with no matches
    // — it only counts yielded paths. A zero-match scan is therefore only
    // interruptible if the walker itself gets the signal, which is what the
    // forwarded `signal` arms. The fake below models a faithful walker: it
    // polls the signal per entry and returns when it fires.
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let entriesVisited = 0;
    let walkFinished = false;
    const glob = vi.fn(
      // eslint-disable-next-line require-yield -- a zero-match scan yields nothing by definition
      async function* (
        _path: string,
        _pattern: string,
        options?: { signal?: AbortSignal },
      ): AsyncGenerator<string> {
        seenSignal = options?.signal;
        // Zero matches; a long walk that only ends on abort (or after a
        // bounded number of entries, so the un-fixed code cannot hang).
        while (options?.signal?.aborted !== true && entriesVisited < 500) {
          entriesVisited++;
          await new Promise((resolve) => {
            setTimeout(resolve, 1);
          });
        }
        walkFinished = true;
      },
    );
    const tool = new GlobTool(
      createFakeJian({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
      workspace,
    );

    const abortTimer = setTimeout(() => {
      controller.abort();
    }, 10);
    try {
      // AbortError is re-thrown (not swallowed into "No matches found") so the
      // runtime can route it to abortedToolOutput — and an aborted scan is
      // never written to the scan cache.
      await expect(
        executeTool(tool, {
          ...context({ pattern: '*.xyz', path: '/workspace' }),
          signal: controller.signal,
        }),
      ).rejects.toThrow();
    } finally {
      clearTimeout(abortTimer);
    }

    expect(seenSignal).toBe(controller.signal);
    expect(walkFinished).toBe(true);
    // The walk stopped when the caller aborted (around 10 entries), instead of
    // running the whole 500-entry stand-in.
    expect(entriesVisited).toBeLessThan(100);
    expect(scanCache.get('/workspace', '*.xyz', true)).toBeUndefined();
  });

  it('mentions Windows path forms in the description on win32 backends', () => {
    // py emits an OS-conditional hint about C:\Users\foo and /c/Users/foo
    // forms; TS currently uses a single static description.
    const tool = new GlobTool(createFakeJian({ pathClass: () => 'win32' }), {
      workspaceDir: 'C:\\workspace',
      additionalDirs: [],
    });

    expect(tool.description).toContain('C:\\Users\\foo');
    expect(tool.description).toContain('/c/Users/foo');
  });
});

/**
 * End-to-end coverage against a real filesystem, driven through a real
 * `LocalJian`. The mocked tests above pin the *call* the tool makes;
 * these pin what the walk actually does when `.git` and `node_modules`
 * exist on disk — including that an explicit query still gets in.
 */
describe('GlobTool against a real filesystem', () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'glob-tool-')));
    await mkdir(join(root, 'src', 'deep'), { recursive: true });
    // Both live under `src` so a single `src/...` pattern has to walk
    // past them — a pattern anchored elsewhere would never reach either.
    await mkdir(join(root, 'src', 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(root, 'src', '.git', 'objects'), { recursive: true });
    await writeFile(join(root, 'src', 'deep', 'kept.txt'), 'kept');
    await writeFile(join(root, 'src', 'node_modules', 'pkg', 'dep.txt'), 'dep');
    await writeFile(join(root, 'src', '.git', 'objects', 'pack.txt'), 'pack');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  function realTool(): GlobTool {
    return new GlobTool(testJian, { workspaceDir: root, additionalDirs: [] });
  }

  it('leaves both .git and node_modules out of a recursive result', async () => {
    const result = await executeTool(realTool(), context({ pattern: 'src/**/*.txt' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('src/deep/kept.txt');
  });

  it('resolves a pattern that addresses node_modules explicitly', async () => {
    const result = await executeTool(
      realTool(),
      context({ pattern: 'src/node_modules/**/*.txt' }),
    );

    expect(result.isError).toBeFalsy();
    // The named directory is walked; the unnamed default (.git) still is not.
    expect(result.output).toBe('src/node_modules/pkg/dep.txt');
    expect(result.output).not.toContain('.git');
  });
});

describe('globExcludesForPattern', () => {
  it('returns the full default list for a pattern with no explicit segment', () => {
    expect(globExcludesForPattern('src/**/*.ts')).toEqual(DEFAULT_GLOB_EXCLUDES);
    expect(globExcludesForPattern('*.ts')).toEqual(DEFAULT_GLOB_EXCLUDES);
  });

  it('drops a name the pattern addresses as its own path segment', () => {
    expect(globExcludesForPattern('node_modules/react/src/**/*.js')).toEqual(['.git']);
    expect(globExcludesForPattern('src/node_modules/*.js')).toEqual(['.git']);
    expect(globExcludesForPattern('.git/config')).toEqual(['node_modules']);
  });

  it('drops every name the pattern addresses explicitly', () => {
    expect(globExcludesForPattern('.git/*/node_modules/*.js')).toEqual([]);
  });

  it('keeps a name that only appears inside a wildcard segment', () => {
    // `*node_modules*` is not a query for a specific tree, so the walk
    // stays pruned; otherwise the guard would hand anyone a wildcard
    // bypass of the default.
    expect(globExcludesForPattern('*node_modules*')).toEqual(DEFAULT_GLOB_EXCLUDES);
  });

  it('does not treat a longer segment containing a name as that name', () => {
    expect(globExcludesForPattern('node_modules_backup/*.js')).toEqual(DEFAULT_GLOB_EXCLUDES);
  });
});

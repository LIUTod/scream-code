import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';

import { describe, expect, it } from 'vitest';

import { pickUiDir, uiDirCandidates } from '../../../src/bot/server/index';

describe('bot UI directory resolution', () => {
  it('looks next to a bundled entrypoint before anything cwd-based', () => {
    const moduleDir = join(tmpdir(), 'pkg', 'dist');
    const candidates = uiDirCandidates(moduleDir, join(tmpdir(), 'user', 'project'));
    expect(candidates[0]).toBe(join(moduleDir, 'bot-ui'));
  });

  it('finds the bundle of an installed package from an unrelated cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'scream-ui-'));
    const pkg = join(root, 'node_modules', 'scream');
    mkdirSync(join(pkg, 'dist', 'bot-ui'), { recursive: true });
    writeFileSync(join(pkg, 'dist', 'bot-ui', 'index.html'), '<!doctype html>');

    const found = pickUiDir(uiDirCandidates(join(pkg, 'dist'), join(root, 'project')));
    expect(found).toBe(join(pkg, 'dist', 'bot-ui'));

    rmSync(root, { recursive: true, force: true });
  });

  it('builds Windows-shaped paths with win32 join', () => {
    const candidates = uiDirCandidates('C:\\pkg\\dist', 'D:\\project', win32.join);
    expect(candidates[0]).toBe('C:\\pkg\\dist\\bot-ui');
    expect(candidates[2]).toBe('D:\\project\\dist\\bot-ui');
    expect(candidates.every((candidate) => !candidate.includes('/'))).toBe(true);
  });

  it('builds POSIX-shaped paths with posix join', () => {
    const candidates = uiDirCandidates('/opt/pkg/dist', '/home/user/project', posix.join);
    expect(candidates[0]).toBe('/opt/pkg/dist/bot-ui');
    expect(candidates.every((candidate) => !candidate.includes('\\'))).toBe(true);
  });

  it('returns nothing when no candidate carries an index page', () => {
    const root = mkdtempSync(join(tmpdir(), 'scream-ui-'));
    expect(pickUiDir(uiDirCandidates(join(root, 'dist'), join(root, 'cwd')))).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});

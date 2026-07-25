import { describe, expect, it } from 'vitest';

import { parseGoalCommand } from '#/tui/commands/goal';

describe('parseGoalCommand', () => {
  it('parses `setup` as the guided-setup subcommand', () => {
    expect(parseGoalCommand('setup')).toEqual({ kind: 'setup' });
  });

  it('parses `setup` and ignores any trailing text', () => {
    expect(parseGoalCommand('setup something')).toEqual({ kind: 'setup' });
    expect(parseGoalCommand('setup   refactor auth')).toEqual({ kind: 'setup' });
  });

  it('still parses `pause` as a control subcommand (unchanged)', () => {
    expect(parseGoalCommand('pause')).toEqual({ kind: 'pause' });
  });

  it('still parses `resume` / `off` / `status` (unchanged)', () => {
    expect(parseGoalCommand('resume')).toEqual({ kind: 'resume' });
    expect(parseGoalCommand('off')).toEqual({ kind: 'off' });
    expect(parseGoalCommand('status')).toEqual({ kind: 'status' });
    expect(parseGoalCommand('')).toEqual({ kind: 'status' });
  });

  it('allows an objective literally named setup via `--` escape', () => {
    expect(parseGoalCommand('-- setup')).toEqual({ kind: 'create', objective: 'setup', replace: false });
  });

  it('parses a plain objective as create', () => {
    expect(parseGoalCommand('refactor auth module')).toEqual({
      kind: 'create',
      objective: 'refactor auth module',
      replace: false,
    });
  });
});

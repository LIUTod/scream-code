import { describe, expect, it } from 'vitest';

import {
  commandApprovalRule,
  matchesCommandRule,
} from '../../../src/tools/support/command-rule';

describe('commandApprovalRule', () => {
  it('normalizes known two-token families to a template', () => {
    expect(commandApprovalRule('Bash', 'git checkout main')).toBe('Bash(git checkout *)');
    expect(commandApprovalRule('Bash', 'git checkout feature/x')).toBe('Bash(git checkout *)');
    expect(commandApprovalRule('Bash', 'npm install -g foo')).toBe('Bash(npm install *)');
    expect(commandApprovalRule('Bash', 'go test ./...')).toBe('Bash(go test *)');
    expect(commandApprovalRule('Bash', 'pip install requests')).toBe('Bash(pip install *)');
  });

  it('keeps literal patterns for unknown families', () => {
    expect(commandApprovalRule('Bash', 'git reset --hard HEAD')).toBe('Bash(git reset --hard HEAD)');
    expect(commandApprovalRule('Bash', 'rm -rf /tmp/x')).toBe('Bash(rm -rf /tmp/x)');
    expect(commandApprovalRule('Bash', 'sudo apt install x')).toBe('Bash(sudo apt install x)');
    expect(commandApprovalRule('Bash', 'git')).toBe('Bash(git)');
  });

  it('keeps literal patterns when the second token is not a plain segment', () => {
    // Family detection uses the first two tokens; a quoted *third* token is
    // still a checkout-family command and normalizes to the family template.
    expect(commandApprovalRule('Bash', 'git checkout "feature/x"')).toBe('Bash(git checkout *)');
    // A quoted second token breaks family detection and stays literal.
    expect(commandApprovalRule('Bash', 'git "checkout" main')).toBe('Bash(git "checkout" main)');
  });

  it('keeps literal patterns for families with destructive subcommands', () => {
    expect(commandApprovalRule('Bash', 'git stash drop stash@{0}')).toBe(
      'Bash(git stash drop stash\\@\\{0\\})',
    );
    expect(commandApprovalRule('Bash', 'git branch -D feature')).toBe('Bash(git branch -D feature)');
    expect(commandApprovalRule('Bash', 'git push --force-with-lease origin main')).toBe(
      'Bash(git push --force-with-lease origin main)',
    );
  });

  it('never generalizes force-style flags into a family template', () => {
    expect(commandApprovalRule('Bash', 'git checkout -f .')).toBe('Bash(git checkout -f .)');
    expect(commandApprovalRule('Bash', 'git checkout --force feature/x')).toBe(
      'Bash(git checkout --force feature/x)',
    );
    expect(commandApprovalRule('Bash', 'git checkout feature/x -f')).toBe(
      'Bash(git checkout feature/x -f)',
    );
    expect(commandApprovalRule('Bash', 'npm install --force foo')).toBe(
      'Bash(npm install --force foo)',
    );
    expect(commandApprovalRule('Bash', 'git reset --hard HEAD')).toBe(
      'Bash(git reset --hard HEAD)',
    );
  });
});

describe('matchesCommandRule', () => {
  it('matches family templates against any trailing argument, including "/" segments', () => {
    expect(matchesCommandRule('git checkout *', 'git checkout main')).toBe(true);
    expect(matchesCommandRule('git checkout *', 'git checkout feature/x')).toBe(true);
    expect(matchesCommandRule('git checkout *', 'git checkout feature/x/y')).toBe(true);
    expect(matchesCommandRule('git checkout *', 'git checkout -- file')).toBe(true);
    expect(matchesCommandRule('git checkout *', 'git checkout')).toBe(true);
  });

  it('does not match a different prefix', () => {
    expect(matchesCommandRule('git checkout *', 'rm -rf /')).toBe(false);
    expect(matchesCommandRule('git checkout *', 'git pull origin main')).toBe(false);
    expect(matchesCommandRule('npm install *', 'npm test')).toBe(false);
  });

  it('matches multi-word flag arguments under the template', () => {
    expect(matchesCommandRule('npm install *', 'npm install --save-dev foo')).toBe(true);
    expect(matchesCommandRule('npm install *', 'npm install -g foo')).toBe(true);
  });

  it('keeps single-segment templates off the segment path (glob semantics preserved)', () => {
    // `rm *` is not a family: it must keep the old glob behaviour — `*` does
    // not cross `/`, so `rm -rf /` stays unmatched.
    expect(matchesCommandRule('rm *', 'rm foo')).toBe(true);
    expect(matchesCommandRule('rm *', 'rm -rf /')).toBe(false);
  });

  it('supports single-word families like pytest', () => {
    expect(matchesCommandRule('pytest *', 'pytest tests/test_a.py')).toBe(true);
    expect(matchesCommandRule('pytest *', 'pytest')).toBe(true);
    expect(matchesCommandRule('pytest *', 'npm test')).toBe(false);
  });

  it('matches family templates even when trailing segments are quoted or variable (prefix-only check)', () => {
    // The template only constrains the family prefix; trailing segments are
    // arbitrary by design (`git checkout *` covers any argument). This is
    // safe because the family whitelist still bounds what can be matched.
    expect(matchesCommandRule('git checkout *', 'git checkout "feature/x"')).toBe(true);
    expect(matchesCommandRule('git checkout *', 'git checkout $BRANCH')).toBe(true);
    // ...but a different prefix is still rejected.
    expect(matchesCommandRule('git checkout *', 'git status')).toBe(false);
  });

  it('honours negation with template semantics', () => {
    expect(matchesCommandRule('!git checkout *', 'git checkout main')).toBe(false);
    expect(matchesCommandRule('!git checkout *', 'git status')).toBe(true);
  });

  it('preserves plain literal and glob rules via the glob path', () => {
    expect(matchesCommandRule('git status', 'git status')).toBe(true);
    expect(matchesCommandRule('git status', 'git log')).toBe(false);
    // `git pull *` is a family; related command without the prefix does not match.
    expect(matchesCommandRule('git pull *', 'git push origin main')).toBe(false);
  });
});

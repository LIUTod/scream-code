import { t } from '@scream-code/config';
import { describe, expect, it, vi } from 'vitest';

import { handleGrantsCommand } from '#/tui/commands/grants';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';

import { makeMockSession, makeMockSlashCommandHost } from '../fixtures/mock-host';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('handleGrantsCommand', () => {
  it('lists the session grants in a picker', async () => {
    const session = makeMockSession({
      overrides: {
        getSessionApprovalGrants: vi.fn(async (): Promise<string[]> => ['Bash', 'Write(src/**)']),
      },
    });
    const host = makeMockSlashCommandHost({ session });

    await handleGrantsCommand(host);

    const picker = vi.mocked(host.mountEditorReplacement).mock.calls[0]?.[0];
    expect(picker).toBeInstanceOf(ChoicePickerComponent);
    const rendered = strip((picker as ChoicePickerComponent).render(80).join('\n'));
    expect(rendered).toContain('Bash');
    expect(rendered).toContain('Write(src/**)');
  });

  it('reports an empty ledger instead of opening a picker', async () => {
    const session = makeMockSession({
      overrides: { getSessionApprovalGrants: vi.fn(async (): Promise<string[]> => []) },
    });
    const host = makeMockSlashCommandHost({ session });

    await handleGrantsCommand(host);

    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(vi.mocked(host.showStatus)).toHaveBeenCalled();
  });

  it('revokes the selected grant and reports it', async () => {
    const revoke = vi.fn(async (): Promise<boolean> => true);
    const session = makeMockSession({
      overrides: {
        getSessionApprovalGrants: vi.fn(async (): Promise<string[]> => ['Bash']),
        revokeSessionApprovalGrant: revoke,
      },
    });
    const host = makeMockSlashCommandHost({ session });

    await handleGrantsCommand(host);
    const picker = vi.mocked(host.mountEditorReplacement).mock.calls[0]?.[0] as ChoicePickerComponent;
    picker.handleInput('\r');

    await vi.waitFor(() => {
      expect(revoke).toHaveBeenCalledWith('Bash');
    });
    await vi.waitFor(() => {
      expect(vi.mocked(host.showStatus)).toHaveBeenCalled();
    });
    expect(host.restoreEditor).toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('reports a load failure instead of opening a picker', async () => {
    const session = makeMockSession({
      overrides: {
        getSessionApprovalGrants: vi.fn(async (): Promise<string[]> => {
          throw new Error('session gone');
        }),
      },
    });
    const host = makeMockSlashCommandHost({ session });

    await handleGrantsCommand(host);

    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(vi.mocked(host.showError)).toHaveBeenCalledWith(
      t('grants.load_failed', { msg: 'session gone' }),
    );
  });

  it('reports a failed revoke instead of claiming success', async () => {
    const session = makeMockSession({
      overrides: {
        getSessionApprovalGrants: vi.fn(async (): Promise<string[]> => ['Bash']),
        revokeSessionApprovalGrant: vi.fn(async (): Promise<boolean> => false),
      },
    });
    const host = makeMockSlashCommandHost({ session });

    await handleGrantsCommand(host);
    const picker = vi.mocked(host.mountEditorReplacement).mock.calls[0]?.[0] as ChoicePickerComponent;
    picker.handleInput('\r');

    await vi.waitFor(() => {
      expect(vi.mocked(host.showError)).toHaveBeenCalled();
    });
    expect(host.restoreEditor).toHaveBeenCalled();
  });
});

/**
 * Login dialog input contract.
 *
 * The dialog is the only input surface for OAuth flows in the TUI, so the two
 * properties flows rely on live here: an empty submission is ignored unless the
 * flow says it is a valid answer, and a flow can cancel a single prompt (the
 * browser callback arrived first) without leaving a focused dead input row.
 */
import { visibleWidth } from '@liutod-scream/pi-tui';
import { describe, expect, it } from 'vitest';

import { LoginDialogComponent } from '#/tui/components/dialogs/login-dialog';
import { darkColors } from '#/tui/theme/colors';

const ANSI = /\u001B\[[0-9;]*m/g;
const OSC8 = /\u001B\]8;;[^\u0007]*\u0007/g;

/** An authorization URL far longer than the card's inner width. */
const LONG_AUTH_URL =
  'https://auth.example.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann' +
  '&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access' +
  '&code_challenge=8fJ2nQ0kzYb1sVpQrW3tKd&code_challenge_method=S256&state=9d1c0b7a4e5f6071';

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

function makeDialog(): LoginDialogComponent {
  return new LoginDialogComponent(
    'TestProvider',
    darkColors,
    () => undefined,
    () => undefined,
    () => undefined,
  );
}

/** Dialog plus the URLs it asked the host to open in a browser. */
function makeDialogWithBrowserSpy(): { dialog: LoginDialogComponent; opened: string[] } {
  const opened: string[] = [];
  const dialog = new LoginDialogComponent(
    'TestProvider',
    darkColors,
    (url) => {
      opened.push(url);
    },
    () => undefined,
    () => undefined,
  );
  return { dialog, opened };
}

function rendered(dialog: LoginDialogComponent): string {
  return dialog.render(72).join('\n').replace(ANSI, '');
}

/** The card's visible text with the frame and every escape sequence removed. */
function plainText(dialog: LoginDialogComponent): string {
  return dialog
    .render(72)
    .map((line) => line.replace(OSC8, '').replace(ANSI, '').replaceAll(/[│╭╮╰╯─]/g, '').trim())
    .join('');
}

describe('LoginDialogComponent prompt input', () => {
  it('ignores an empty submission when the flow did not allow one', async () => {
    const dialog = makeDialog();
    const pending = dialog.promptInput('Paste the callback URL');
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    dialog.handleInput('\n');
    await tick();
    expect(settled).toBe(false);

    // A real answer still gets through.
    dialog.handleInput('https://127.0.0.1:1455/auth/callback?code=abc');
    dialog.handleInput('\n');
    await expect(pending).resolves.toBe('https://127.0.0.1:1455/auth/callback?code=abc');
  });

  it('accepts an empty answer when the flow allows one', async () => {
    const dialog = makeDialog();
    // The GitHub Copilot flow documents "blank for github.com".
    const pending = dialog.promptInput('GitHub Enterprise URL/domain (blank for github.com)', undefined, {
      allowEmpty: true,
    });

    dialog.handleInput('\n');
    await expect(pending).resolves.toBe('');
  });

  it('clears a prompt cancelled through its own signal', async () => {
    const dialog = makeDialog();
    const controller = new AbortController();
    const pending = dialog.promptInput('Paste the callback URL', undefined, {
      signal: controller.signal,
    });
    expect(rendered(dialog)).toContain('Paste the callback URL');

    controller.abort();

    await expect(pending).rejects.toThrow('Login cancelled');
    // The stale prompt row is gone, so the next step renders on its own.
    expect(rendered(dialog)).not.toContain('Paste the callback URL');
  });

  it('drops a pending prompt once the flow completes', () => {
    const dialog = makeDialog();
    void dialog.promptInput('Paste the callback URL');
    expect(rendered(dialog)).toContain('Paste the callback URL');

    dialog.complete();
    expect(rendered(dialog)).not.toContain('Paste the callback URL');
  });
});

describe('LoginDialogComponent URL lines', () => {
  it('ignores a late flow step once the dialog was cancelled', () => {
    const { dialog, opened } = makeDialogWithBrowserSpy();

    dialog.cancel();
    const contentAfterCancel = rendered(dialog);

    dialog.showAuth(LONG_AUTH_URL);
    dialog.showDeviceCode({ userCode: 'ABCD-1234', verificationUri: LONG_AUTH_URL });

    // An abandoned sign-in neither launches a browser nor appends a step.
    expect(opened).toEqual([]);
    expect(rendered(dialog)).toBe(contentAfterCancel);
  });

  it('wraps a long authorization URL instead of truncating it', () => {
    const dialog = makeDialog();
    dialog.showAuth(LONG_AUTH_URL);

    const lines = dialog.render(72);
    // No row may overflow the card, however long the URL is.
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(72);
    }

    // The URL survives in full — a truncated tail loses the query parameters
    // the browser needs (state, code_challenge_method) and sign-in fails.
    const text = plainText(dialog);
    expect(text).toContain(LONG_AUTH_URL);
    expect(text).not.toContain('…');

    const linkedRows = lines.filter((line) => line.includes('\u001B]8;;'));
    expect(linkedRows.length).toBeGreaterThan(1);
    // Every row of the URL links to the whole URL, not to its own fragment.
    for (const row of linkedRows) {
      expect(row).toContain(`\u001B]8;;${LONG_AUTH_URL}\u0007`);
    }
  });

  it('wraps the device-code verification URL the same way', () => {
    const dialog = makeDialog();
    dialog.showDeviceCode({ userCode: 'ABCD-1234', verificationUri: LONG_AUTH_URL });

    const text = plainText(dialog);
    expect(text).toContain(LONG_AUTH_URL);
    expect(text).toContain('ABCD-1234');
    expect(text).not.toContain('…');
  });

  it('wraps a long info message that carries a URL in its text', () => {
    const dialog = makeDialog();
    const message = `Port 1455 is in use; listening on ${LONG_AUTH_URL} instead.`;
    dialog.showInfo(message);

    const text = plainText(dialog);
    // The URL and the sentence's tail both survive: the tail is what tells the
    // user which address this sign-in is actually listening on.
    expect(text).toContain(LONG_AUTH_URL);
    expect(text).toContain('instead.');
    expect(text).not.toContain('…');

    for (const line of dialog.render(72)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(72);
    }
  });

  it('still truncates a long non-URL content line', () => {
    const dialog = makeDialog();
    const longMessage = `Instruction: ${'y'.repeat(300)}`;
    dialog.showInfo(longMessage);

    const text = plainText(dialog);
    expect(text).not.toContain(longMessage);
    expect(text).toContain('…');
  });
});

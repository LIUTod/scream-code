import { t } from '@scream-code/config';
import type { AuthPrompt, LoginProviderInfo, ProviderAuthInteraction } from '@scream-code/scream-code-sdk';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { LoginDialogComponent } from '../components/dialogs/login-dialog';
import { formatErrorMessage } from '../utils/event-payload';
import { openUrl } from '../utils/open-url';

import type { SlashCommandHost } from './dispatch';
import { promptLoginProviderSelection } from './prompts';

// ---------------------------------------------------------------------------
// Auth: login (OAuth provider sign-in)
// ---------------------------------------------------------------------------

export async function handleLoginCommand(host: SlashCommandHost, args: string = ''): Promise<void> {
  const providers = host.harness.auth.listOAuthProviders();
  if (providers.length === 0) {
    host.showStatus(t('login.no_providers'));
    return;
  }

  const requested = args.trim().toLowerCase();
  // Direct selection: exactly one provider matches the requested text, either
  // as its id, its display name (exact or a unique prefix, e.g. `/login kimi`)
  // or one '-'-separated segment of its id (`/login codex` →
  // `openai-codex`, `/login gemini` → `google-gemini-cli`). Zero or several
  // matches fall back to the interactive picker instead of guessing.
  const matches =
    requested.length > 0
      ? providers.filter((provider) => matchesRequestedProvider(provider, requested))
      : [];
  const direct = matches.length === 1 ? matches[0] : undefined;
  const selected =
    direct?.id ?? (await promptLoginProviderSelection(host, buildProviderOptions(host, providers)));
  if (selected === undefined) return;
  const provider = direct ?? providers.find((candidate) => candidate.id === selected);
  if (provider === undefined) return;
  await runLoginFlow(host, provider);
}

/**
 * Requested text names this provider: exact id, exact or leading display name,
 * or any '-'-separated segment of the id. Id segments are matched because
 * provider ids carry a namespace prefix while users name the vendor
 * (`openai-codex` is what `/login codex` means, and the display names of the
 * two ChatGPT providers share their prefix).
 */
function matchesRequestedProvider(provider: LoginProviderInfo, requested: string): boolean {
  return (
    provider.id === requested ||
    provider.name.toLowerCase().startsWith(requested) ||
    provider.id.split('-').includes(requested)
  );
}

function buildProviderOptions(
  host: SlashCommandHost,
  providers: readonly LoginProviderInfo[],
): ChoiceOption[] {
  return providers.map((provider) => ({
    value: provider.id,
    label: provider.name,
    description: host.harness.auth.hasOAuthCredential(provider.id)
      ? t('login.configured')
      : t('login.unconfigured'),
  }));
}

async function runLoginFlow(host: SlashCommandHost, provider: LoginProviderInfo): Promise<void> {
  const panel = new LoginDialogComponent(
    provider.name,
    host.state.theme.colors,
    openUrl,
    () => {
      host.state.ui.requestRender();
    },
    // Completion signal; the caller owns editor restoration.
    () => undefined,
  );
  host.mountEditorReplacement(panel);
  panel.showProgress(t('login.waiting'));

  const interaction: ProviderAuthInteraction = {
    signal: panel.signal,
    notify: (event) => {
      switch (event.type) {
        case 'auth_url':
          panel.showAuth(event.url, event.instructions);
          break;
        case 'device_code':
          panel.showDeviceCode({
            userCode: event.userCode,
            verificationUri: event.verificationUri,
          });
          break;
        case 'progress':
          panel.showProgress(event.message);
          break;
        case 'info':
          panel.showInfo(event.message, event.links ?? []);
          break;
      }
    },
    prompt: (prompt) => promptFromDialog(host, panel, prompt),
  };

  let result: Awaited<ReturnType<typeof host.harness.auth.loginOAuthProvider>>;
  try {
    result = await host.harness.auth.loginOAuthProvider(provider.id, interaction);
  } catch (error) {
    host.restoreEditor();
    if (panel.signal.aborted || (error instanceof Error && error.message === 'Login cancelled')) {
      host.showStatus(t('login.cancelled'));
    } else {
      host.showError(t('login.failed', { message: formatErrorMessage(error) }));
    }
    host.state.ui.requestRender();
    return;
  }

  panel.complete();
  host.restoreEditor();

  // The credential is on disk by now. Saving the provider entry and the config
  // refresh are a separate step: reporting them as a failed sign-in would tell
  // the user to sign in again although the credential is already stored.
  try {
    await persistProviderEntry(host, provider, result.requestAuth);
    await host.authFlow.refreshConfigAfterLogin();
    host.showStatus(t('login.success', { name: result.providerName }));
  } catch (error) {
    host.showError(t('login.persist_failed', { message: formatErrorMessage(error) }));
  } finally {
    host.state.ui.requestRender();
  }
}

/**
 * Bridge a flow prompt to the dialog. `select` prompts temporarily swap the
 * login panel for the choice picker; everything else uses the panel's input.
 *
 * `allowEmpty` and `signal` travel with the prompt: the first lets a flow
 * accept a blank answer, the second lets the flow drop a prompt that another
 * input path (the browser callback) has already superseded.
 */
function promptFromDialog(
  host: SlashCommandHost,
  panel: LoginDialogComponent,
  prompt: AuthPrompt,
): Promise<string> {
  if (prompt.type !== 'select') {
    return panel.promptInput(prompt.message, prompt.placeholder, {
      allowEmpty: prompt.allowEmpty === true,
      signal: prompt.signal,
    });
  }
  return new Promise<string>((resolve, reject) => {
    const picker = new ChoicePickerComponent({
      title: prompt.message,
      colors: host.state.theme.colors,
      options: prompt.options.map((option) => ({
        value: option.id,
        label: option.label,
        description: option.description,
      })),
      onSelect: (value: string) => {
        host.mountEditorReplacement(panel);
        host.state.ui.requestRender();
        resolve(value);
      },
      onCancel: () => {
        host.mountEditorReplacement(panel);
        host.state.ui.requestRender();
        reject(new Error('Login cancelled'));
      },
    });
    host.mountEditorReplacement(picker);
    host.state.ui.requestRender();
  });
}

/**
 * Write the provider entry (oauth reference, api key cleared) and persist.
 *
 * The api key is cleared with an explicit empty string rather than a dropped
 * field: the host merges this patch into the config already on disk, and a
 * missing field leaves the stored `apiKey` in place — the entry would then
 * carry an api key and an oauth reference at once, which the request path
 * rejects as ambiguous. `providerApiKey` normalizes the empty string back to
 * "no key", so the persisted entry is equivalent to an absent field.
 *
 * No model alias is written here: an alias has to name a real model of this
 * provider, and this command does not own that catalog. The success message
 * points at /model and /config instead of guessing a model list.
 */
async function persistProviderEntry(
  host: SlashCommandHost,
  provider: LoginProviderInfo,
  requestAuth: { readonly baseUrl?: string } | undefined,
): Promise<void> {
  // Reload so the patch is built from what is on disk: another writer (or a
  // hand edit) must not be reverted by re-sending a stale in-memory snapshot.
  const config = await host.harness.getConfig({ reload: true });
  const providers = config.providers as Record<string, Record<string, unknown>>;
  // The sign-in target's wire always wins: an entry may have been written by an
  // older sign-in (a different wire) or hand-configured with another protocol,
  // and after this sign-in it is served by this provider's request path.
  const entry: Record<string, unknown> = {
    ...providers[provider.id],
    apiKey: '',
    type: provider.providerConfigType ?? provider.id,
  };
  // A base URL already configured for this provider (proxy, mirror, gateway)
  // is preserved; the sign-in default only fills the gap when none is set. This
  // describes what is written to config.toml, not a request-time precedence
  // claim: each wire resolves its own base URL at request time.
  const configuredBaseUrl = entry['baseUrl'];
  const hasConfiguredBaseUrl =
    typeof configuredBaseUrl === 'string' && configuredBaseUrl.trim().length > 0;
  if (
    !hasConfiguredBaseUrl &&
    typeof requestAuth?.baseUrl === 'string' &&
    requestAuth.baseUrl.length > 0
  ) {
    entry['baseUrl'] = requestAuth.baseUrl;
  }
  entry['oauth'] = { storage: 'file', key: provider.id };
  providers[provider.id] = entry;
  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: config.defaultModel,
    defaultThinking: config.defaultThinking,
  });
}

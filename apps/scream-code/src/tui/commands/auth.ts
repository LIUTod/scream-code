import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { t } from '@scream-code/config';
import {
  applyCatalogProvider,
  catalogBaseUrl,
  catalogModelToAlias,
  catalogProviderModels,
  fetchCatalog,
  inferWireType,
  loadBuiltInCatalog,
  loadCatalogCache,
  resolveScreamHome,
  saveCatalogCache,
  type Catalog,
  type CatalogModel,
} from '@scream-code/scream-code-sdk';

import { BUILT_IN_CATALOG_JSON } from '../../built-in-catalog';
import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';

import { resolveConnectCatalogRequest } from '../utils/connect-catalog';
import { formatErrorMessage } from '../utils/event-payload';
import {
  promptApiKey,
  promptAudioMode,
  promptCatalogProviderSelection,
  promptImageMode,
  promptLogoutProviderSelection,
  promptModelSelectionForCatalog,
  promptThinkingMode,
  promptTextInput,
  promptVideoMode,
  promptWireType,
} from './prompts';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Auth: logout / connect
// ---------------------------------------------------------------------------

export async function handleConnectCommand(host: SlashCommandHost, args: string): Promise<void> {
  const { url, diy, image } = resolveConnectCatalogRequest(args);

  if (image) {
    await handleImageConfig(host);
    return;
  }
  if (diy) {
    await handleDiyConfig(host);
    return;
  }

  let catalog: Catalog | undefined;
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancel;

  const spinner = host.showProgressSpinner(t('auth.fetching_models'));
  try {
    catalog = await fetchCatalog(url, controller.signal);
    spinner.stop({ ok: true, label: 'Catalog loaded.' });
    saveCatalogCache(catalog, resolveScreamHome());
  } catch (error) {
    if (controller.signal.aborted) {
      spinner.stop({ ok: false, label: 'Aborted.' });
    } else {
      // Remote failed — try cache, then built-in
      const screamHome = resolveScreamHome();
      const cached = loadCatalogCache(screamHome);
      if (cached !== undefined) {
        spinner.stop({ ok: true, label: 'Using cached catalog (offline mode).' });
        catalog = cached;
      } else {
        const fallback = loadBuiltInCatalog(BUILT_IN_CATALOG_JSON);
        if (fallback !== undefined) {
          spinner.stop({ ok: true, label: 'Using built-in catalog (offline mode).' });
          catalog = fallback;
        } else {
          spinner.stop({ ok: false, label: 'Failed to load catalog.' });
          host.showError(t('auth.catalog_fetch_failed', { error: formatErrorMessage(error) }));
        }
      }
    }
  } finally {
    if (host.cancelInFlight === cancel) host.cancelInFlight = undefined;
  }

  if (catalog === undefined) return;

  const providerId = await promptCatalogProviderSelection(host, catalog);
  if (providerId === undefined) return;
  const entry = catalog[providerId];
  if (entry === undefined) return;

  const models = catalogProviderModels(entry);
  if (models.length === 0) {
    host.showError(`Provider "${providerId}" has no usable models in this catalog.`);
    return;
  }

  const selection = await promptModelSelectionForCatalog(host, providerId, models);
  if (selection === undefined) return;

  const apiKey = await promptApiKey(host, entry.name ?? providerId);
  if (apiKey === undefined) return;

  const wire = inferWireType(entry);
  if (wire === undefined) return;
  const baseUrl = catalogBaseUrl(entry, wire);

  const existingConfig = await host.harness.getConfig();
  if (existingConfig.providers[providerId] !== undefined) {
    await host.harness.removeProvider(providerId);
  }

  const config = await host.harness.getConfig();
  applyCatalogProvider(config, {
    providerId,
    wire,
    baseUrl,
    apiKey,
    models,
    selectedModelId: selection.model.id,
    thinkingLevel: selection.thinkingLevel,
  });

  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: config.defaultModel,
    defaultThinking: config.defaultThinking,
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.showStatus(`Connected: ${entry.name ?? providerId} · ${selection.model.id}`);
}

export async function handleLogoutCommand(host: SlashCommandHost): Promise<void> {
  const config = await host.harness.getConfig();
  const providerIds = Object.keys(config.providers ?? {}).toSorted();

  if (providerIds.length === 0) {
    host.showStatus(t('auth.no_providers'));
    return;
  }

  const options: ChoiceOption[] = [];
  for (const id of providerIds) {
    const baseUrl = config.providers[id]?.baseUrl;
    options.push({
      value: id,
      label: id,
      description: typeof baseUrl === 'string' && baseUrl.length > 0 ? baseUrl : undefined,
    });
  }

  const currentModel = host.state.appState.model.trim();
  const currentProvider = host.state.appState.availableModels[currentModel]?.provider;

  const target = await promptLogoutProviderSelection(host, options, currentProvider);
  if (target === undefined) return;

  await host.harness.removeProvider(target);

  if (target === currentProvider) {
    await host.authFlow.refreshConfigAfterLogout();
    await host.authFlow.clearActiveSessionAfterLogout();
  } else {
    const updated = await host.harness.getConfig({ reload: true });
    host.setAppState({
      availableModels: updated.models ?? {},
      availableProviders: updated.providers ?? {},
    });
  }
  host.showStatus(t('auth.deleted', { name: target }));
}

// ── /config diy — manual provider setup ────────────────────────────────

async function handleDiyConfig(host: SlashCommandHost): Promise<void> {
  // Step 1 — wire type
  const wire = await promptWireType(host);
  if (wire === undefined) return;
  const isGoogle = wire === 'google-genai';

  // Step 2 — base URL (required for every wire type)
  const baseUrlInput = await promptTextInput(host, t('auth.input_api_url'), {
    subtitle: isGoogle ? t('auth.api_url_hint_google') : t('auth.api_url_hint'),
  });
  if (baseUrlInput === undefined) return;
  const baseUrl = baseUrlInput.trim();
  if (!baseUrl) {
    host.showError(t('auth.error_empty_base_url'));
    return;
  }

  // Step 3 — API key (plaintext so the user can verify what they typed)
  const apiKey = await promptTextInput(host, t('auth.input_api_key'), {
    subtitle: t('auth.api_key_hint'),
  });
  if (apiKey === undefined) return;

  // Step 4 — model ID
  const modelId = await promptTextInput(host, t('auth.input_model'), {
    subtitle: isGoogle ? t('auth.model_hint_google') : t('auth.model_hint'),
  });
  if (modelId === undefined) return;
  if (!modelId.trim()) {
    host.showError(t('auth.error_empty_model_id'));
    return;
  }

  // Step 5 — max context tokens
  const maxContextStr = await promptTextInput(host, t('auth.input_context'), {
    subtitle: isGoogle ? t('auth.context_hint_google') : t('auth.context_hint'),
  });
  if (maxContextStr === undefined) return;
  const parsed = parseInt(maxContextStr, 10);
  if (Number.isNaN(parsed) || parsed < 4096) {
    host.showError(t('auth.error_invalid_context_size'));
    return;
  }
  const maxContextTokens = parsed;

  // Step 6 — thinking level
  const thinkingLevel = await promptThinkingMode(host);
  if (thinkingLevel === undefined) return;

  // Step 7 — multimodal inputs
  const imageEnabled = await promptImageMode(host);
  if (imageEnabled === undefined) return;
  const videoEnabled = await promptVideoMode(host);
  if (videoEnabled === undefined) return;
  const audioEnabled = await promptAudioMode(host);
  if (audioEnabled === undefined) return;

  // Build a provider ID from the model name
  const providerId = `custom-${modelId.replaceAll(/[^A-Za-z0-9._-]/g, '-')}`;

  // Build a minimal catalog model entry
  const catalogModel: CatalogModel = {
    id: modelId,
    name: modelId,
    capability: {
      max_context_tokens: maxContextTokens,
      image_in: imageEnabled,
      video_in: videoEnabled,
      audio_in: audioEnabled,
      thinking: thinkingLevel !== 'off',
      tool_use: true,
    },
    // google-genai maps thinking levels via its own thinking_config; the
    // reasoning-key convention only applies to anthropic.
    reasoningKey: wire === 'anthropic' ? 'thinking' : undefined,
    maxOutputSize: wire === 'anthropic' ? 32_000 : undefined,
  };

  // Apply to config via the shared catalog codepath (handles same-provider
  // old-model cleanup, provider removal, and model/thinking standardization).
  const config = await host.harness.getConfig();
  if (config.providers[providerId] !== undefined) {
    await host.harness.removeProvider(providerId);
  }
  const freshConfig = await host.harness.getConfig();
  applyCatalogProvider(freshConfig, {
    providerId,
    wire: wire as 'openai' | 'openai_responses' | 'anthropic' | 'google-genai',
    baseUrl,
    apiKey,
    models: [catalogModel],
    selectedModelId: modelId,
    thinkingLevel,
  });

  await host.harness.setConfig({
    providers: freshConfig.providers,
    models: freshConfig.models,
    defaultModel: freshConfig.defaultModel,
    defaultThinking: freshConfig.defaultThinking,
    thinking: freshConfig.thinking,
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.showStatus(t('auth.connected', { name: `${providerId} · ${modelId} (${wire})` }));
}

// ── /config image — image-generation API setup ─────────────────────────

interface ImageProviderPreset {
  readonly id: string;
  /** Literal label (for future named stations). */
  readonly label?: string;
  /** i18n key resolved at prompt time (language can change between runs). */
  readonly labelKey?: string;
  /** Prefilled base URL; empty means the user must type one. */
  readonly baseUrl: string;
  readonly model: string;
}

/**
 * Service presets for the image wizard: quick entries for services whose
 * image API follows the OpenAI-compatible contract this tool speaks, plus
 * the free-form custom entry. Non-compatible shapes stay out until they get
 * dedicated adapters — a preset that cannot actually generate is a bug.
 */
const IMAGE_PROVIDER_PRESETS: readonly ImageProviderPreset[] = [
  {
    id: 'openai',
    labelKey: 'image.provider_openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-2',
  },
  {
    id: 'volcengine',
    labelKey: 'image.provider_volcengine',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-4-5-251128',
  },
  {
    id: 'openai-compatible',
    labelKey: 'image.provider_generic',
    baseUrl: '',
    model: 'gpt-image-2',
  },
];

interface ImageConfigFile {
  provider: string;
  base_url: string;
  api_key: string;
  model: string;
  size: string;
  /** Optional image-edit base; empty/absent = same as base_url. */
  edit_base_url?: string;
  /** Optional image-edit model; empty/absent = same as model. */
  edit_model?: string;
}

function getImageConfigPath(): string {
  return join(resolveScreamHome(), 'image-config.json');
}

/** Best-effort read of an existing image config (never throws, never exposes the key). */
async function readExistingImageConfig(): Promise<
  { provider: string; model: string; baseUrl: string } | undefined
> {
  try {
    const text = await readFile(getImageConfigPath(), 'utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const baseUrl = typeof parsed['base_url'] === 'string' ? parsed['base_url'].trim() : '';
    const model = typeof parsed['model'] === 'string' ? parsed['model'].trim() : '';
    const apiKey = typeof parsed['api_key'] === 'string' ? parsed['api_key'].trim() : '';
    // Same predicate the tool's loadConfig applies: a config that the tool
    // would reject must not be advertised as "already configured" here.
    const usable =
      baseUrl.length > 0 &&
      !baseUrl.includes('replace-with') &&
      model.length > 0 &&
      apiKey.length > 0 &&
      !apiKey.includes('replace-with') &&
      !(apiKey.startsWith('<') && apiKey.endsWith('>'));
    if (usable) {
      return {
        provider: typeof parsed['provider'] === 'string' ? parsed['provider'] : 'openai-compatible',
        model,
        baseUrl,
      };
    }
  } catch {
    // Missing or malformed file — treat as unconfigured.
  }
  return undefined;
}

/**
 * Normalize the URL exactly as the user typed it: trim whitespace and
 * trailing slashes only (a trailing slash would double up against the
 * endpoint path). No path is ever appended — what you type is what runs.
 */
function normalizeImageUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function imagePresetLabel(preset: ImageProviderPreset): string {
  if (preset.label !== undefined) return preset.label;
  if (preset.labelKey !== undefined) return t(preset.labelKey);
  return preset.id;
}

function promptImageProviderPreset(host: SlashCommandHost, hint?: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const options: ChoiceOption[] = IMAGE_PROVIDER_PRESETS.map((preset) => ({
      value: preset.id,
      label: imagePresetLabel(preset),
      description: preset.baseUrl.length > 0 ? preset.baseUrl : undefined,
    }));
    const picker = new ChoicePickerComponent({
      title: t('image.provider_title'),
      hint: hint ?? t('image.provider_hint'),
      options,
      colors: host.state.theme.colors,
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

/**
 * GET {base}/models to verify connectivity and model availability.
 * Never blocks saving: the wizard reports the result on the spinner
 * label and continues either way.
 */
async function runImageDiagnose(host: SlashCommandHost, config: ImageConfigFile): Promise<void> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 2_000);
  const cancel = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancel;
  const spinner = host.showProgressSpinner(t('image.checking'));
  try {
    const response = await fetch(`${config.base_url}/models`, {
      headers: { Authorization: `Bearer ${config.api_key}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      spinner.stop({ ok: false, label: `${t('image.check_failed')} (HTTP ${response.status})` });
      return;
    }
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    const ids = Array.isArray(body.data) ? body.data.map((m) => m.id) : [];
    if (ids.length > 0 && !ids.includes(config.model)) {
      spinner.stop({ ok: false, label: t('image.check_model_missing') });
      return;
    }
    spinner.stop({ ok: true, label: t('image.check_ok') });
  } catch (error) {
    if (controller.signal.aborted) {
      spinner.stop({ ok: false, label: timedOut ? `${t('image.check_failed')} (timeout)` : 'Cancelled.' });
      return;
    }
    spinner.stop({ ok: false, label: `${t('image.check_failed')} (${formatErrorMessage(error)})` });
  } finally {
    clearTimeout(timeoutId);
    if (host.cancelInFlight === cancel) host.cancelInFlight = undefined;
  }
}

async function handleImageConfig(host: SlashCommandHost): Promise<void> {
  // Surface the current configuration first so the user knows a re-run
  // will overwrite it (status line + the first dialog's hint line).
  const existing = await readExistingImageConfig();
  let entryHint = t('image.provider_hint');
  if (existing !== undefined) {
    const preset = IMAGE_PROVIDER_PRESETS.find((p) => p.id === existing.provider);
    const providerLabel = preset !== undefined ? imagePresetLabel(preset) : existing.provider;
    entryHint = t('image.already_configured', {
      model: existing.model,
      provider: providerLabel,
      url: existing.baseUrl,
    });
    host.showStatus(entryHint);
  }

  // Step 1 — service preset
  const presetId = await promptImageProviderPreset(host, entryHint);
  if (presetId === undefined) return;
  const preset = IMAGE_PROVIDER_PRESETS.find((p) => p.id === presetId);
  if (preset === undefined) return;

  // Step 2 — base URL: quick presets carry their canonical URL and skip
  // this prompt entirely; only the custom entry asks for a URL.
  let baseUrl = '';
  if (preset.baseUrl.length > 0) {
    baseUrl = normalizeImageUrl(preset.baseUrl);
  } else {
    const urlInput = await promptTextInput(host, t('image.input_url'), {
      subtitle: t('image.url_hint'),
    });
    if (urlInput === undefined) return;
    baseUrl = normalizeImageUrl(urlInput);
    if (baseUrl.length === 0) {
      host.showError(t('image.error_empty_url'));
      return;
    }
  }

  // Step 3 — API key (masked; written to the local config file only, never
  // returned to the model context).
  const apiKey = await promptTextInput(host, t('image.input_key'), {
    subtitle: t('image.key_hint'),
    masked: true,
  });
  if (apiKey === undefined) return;
  const trimmedKey = apiKey.trim();
  if (trimmedKey.length === 0) {
    host.showError(t('image.error_empty_key'));
    return;
  }

  // Step 4 — model id (empty keeps the preset default)
  const modelInput = await promptTextInput(host, t('image.input_model'), {
    subtitle: t('image.model_hint'),
    placeholder: preset.model,
    allowEmpty: true,
  });
  if (modelInput === undefined) return;
  const model = modelInput.trim().length > 0 ? modelInput.trim() : preset.model;

  // Optional image-edit overrides — only asked for the custom entry, and
  // both accept Enter to keep the text-to-image values. Services that split
  // the two channels (different base path or an edit-specific model) fill
  // them here; the OpenAI-contract presets never need them.
  let editBaseUrl: string | undefined;
  let editModel: string | undefined;
  if (preset.baseUrl.length === 0) {
    const editUrlInput = await promptTextInput(host, t('image.input_edit_url'), {
      subtitle: t('image.edit_url_hint'),
      allowEmpty: true,
    });
    if (editUrlInput === undefined) return;
    if (editUrlInput.trim().length > 0) {
      const normalizedEdit = normalizeImageUrl(editUrlInput);
      if (normalizedEdit.length > 0) editBaseUrl = normalizedEdit;
    }

    const editModelInput = await promptTextInput(host, t('image.input_edit_model'), {
      subtitle: t('image.edit_model_hint'),
      placeholder: model,
      allowEmpty: true,
    });
    if (editModelInput === undefined) return;
    if (editModelInput.trim().length > 0) editModel = editModelInput.trim();
  }

  const config: ImageConfigFile = {
    provider: preset.id,
    base_url: baseUrl,
    api_key: trimmedKey,
    model,
    size: 'auto',
    ...(editBaseUrl !== undefined ? { edit_base_url: editBaseUrl } : {}),
    ...(editModel !== undefined ? { edit_model: editModel } : {}),
  };
  try {
    // Create with 0600 so the key never passes through a world-readable
    // window; chmod keeps pre-existing files at 0600 as well.
    await writeFile(getImageConfigPath(), `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(getImageConfigPath(), 0o600);
  } catch (error) {
    host.showError(formatErrorMessage(error));
    return;
  }

  await runImageDiagnose(host, config);
  host.showStatus(t('image.configured', { provider: imagePresetLabel(preset), model }));
}

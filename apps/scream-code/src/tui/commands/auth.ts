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
import type { ChoiceOption } from '../components/dialogs/choice-picker';

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
  const { url, diy } = resolveConnectCatalogRequest(args);

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

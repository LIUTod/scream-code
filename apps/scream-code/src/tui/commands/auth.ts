import {
  applyCatalogProvider,
  catalogBaseUrl,
  catalogProviderModels,
  CatalogFetchError,
  fetchCatalog,
  inferWireType,
  loadBuiltInCatalog,
  loadCatalogCache,
  resolveScreamHome,
  saveCatalogCache,
  type Catalog,
} from '@scream-cli/scream-code-sdk';

import { BUILT_IN_CATALOG_JSON } from '../../built-in-catalog';
import type { ChoiceOption } from '../components/dialogs/choice-picker';

import { resolveConnectCatalogRequest } from '../utils/connect-catalog';
import { formatErrorMessage } from '../utils/event-payload';
import {
  promptApiKey,
  promptCatalogProviderSelection,
  promptLogoutProviderSelection,
  promptModelSelectionForCatalog,
} from './prompts';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Auth: logout / connect
// ---------------------------------------------------------------------------

export async function handleConnectCommand(host: SlashCommandHost, args: string): Promise<void> {
  const resolution = resolveConnectCatalogRequest(args);
  if (resolution.kind === 'error') {
    host.showError(resolution.message);
    return;
  }
  const { url, preferBuiltIn, allowBuiltInFallback } = resolution.request;

  let catalog: Catalog | undefined;

  if (preferBuiltIn) {
    const builtIn = loadBuiltInCatalog(BUILT_IN_CATALOG_JSON);
    if (builtIn !== undefined) {
      host.showStatus('已加载内置目录。运行 /config refresh 获取最新。');
      catalog = builtIn;
    }
  }

  if (catalog === undefined) {
    const controller = new AbortController();
    const cancel = (): void => {
      controller.abort();
    };
    host.cancelInFlight = cancel;

    const spinner = host.showProgressSpinner(`Fetching catalog from ${url}`);
    try {
      catalog = await fetchCatalog(url, controller.signal);
      spinner.stop({ ok: true, label: 'Catalog loaded.' });
      // Persist to local cache so we have a fresh copy next time we're offline
      saveCatalogCache(catalog, resolveScreamHome());
    } catch (error) {
      if (controller.signal.aborted) {
        spinner.stop({ ok: false, label: 'Aborted.' });
      } else {
        const hint = error instanceof CatalogFetchError ? ` (HTTP ${error.status})` : '';
        if (!allowBuiltInFallback) {
          spinner.stop({ ok: false, label: 'Failed to load catalog.' });
          host.showError(`Failed to fetch catalog${hint}: ${formatErrorMessage(error)}`);
        } else {
          const screamHome = resolveScreamHome();
          // 1) local cache (last successful fetch)
          const cached = loadCatalogCache(screamHome);
          if (cached !== undefined) {
            spinner.stop({ ok: true, label: 'Using cached catalog (offline mode).' });
            catalog = cached;
          } else {
            // 2) built-in (shipped at build time)
            const fallback = loadBuiltInCatalog(BUILT_IN_CATALOG_JSON);
            if (fallback !== undefined) {
              spinner.stop({ ok: true, label: 'Using built-in catalog (offline mode).' });
              catalog = fallback;
            } else {
              spinner.stop({ ok: false, label: 'Failed to load catalog.' });
              host.showError(`Failed to fetch catalog${hint}: ${formatErrorMessage(error)}`);
            }
          }
        }
      }
    } finally {
      if (host.cancelInFlight === cancel) host.cancelInFlight = undefined;
    }
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
    thinking: selection.thinking,
  });

  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: config.defaultModel,
    defaultThinking: config.defaultThinking,
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.track('config', { provider: providerId, model: selection.model.id });
  host.showStatus(`Connected: ${entry.name ?? providerId} · ${selection.model.id}`);
}

export async function handleLogoutCommand(host: SlashCommandHost): Promise<void> {
  const config = await host.harness.getConfig();
  const providerIds = Object.keys(config.providers ?? {}).toSorted();

  if (providerIds.length === 0) {
    host.showStatus('没有已配置的模型商。');
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

  host.track('logout', { provider: target });
  host.showStatus(`已删除模型商: ${target}.`);
}

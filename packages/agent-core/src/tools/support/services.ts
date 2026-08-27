import type { ExtensionRuntime } from '../../plugin/runtime/extension';
import type { PluginManager } from '../../plugin/manager';
import type { PluginSyncReport } from '../../plugin/types';
import type { UrlFetcher, WebSearchProvider } from '../builtin';

export interface ToolServices {
  readonly urlFetcher?: UrlFetcher;
  readonly webSearcher?: WebSearchProvider;
  /**
   * The process-wide plugin table. Tools that install plugins must use this
   * shared instance rather than constructing their own, otherwise two writers
   * clobber `plugins/installed.json` and the live in-memory table never learns
   * about the new plugin.
   */
  readonly plugins?: PluginManager;
  /**
   * The process-wide loader for code-entry plugins (manifest `entryPoint`).
   *
   * Paired with {@link ToolServices.plugins} so a tool that activates a plugin
   * reaches the same runtime the host uses; activation state lives here and
   * nowhere else. Absent in hosts that never load code plugins, in which case
   * activation is reported as unavailable instead of silently skipped.
   */
  readonly extensionRuntime?: ExtensionRuntime;
  /**
   * Push the current plugin table into every live session — MCP servers, plugin
   * skills, and in-process tool teardown — so a change made from inside the
   * running session takes effect now rather than at next launch.
   *
   * The host owns this entry point because it owns the session table; a tool
   * that mutates plugins calls it after every successful write. `changedIds`
   * narrows the work to the plugins that just changed; omit it for a full
   * rescan (what `reload` does). The returned report is advisory: a failed
   * sub-action is recorded in `failed[]` and never thrown back to the caller,
   * because the plugin mutation it follows already succeeded.
   */
  readonly pluginSync?: (
    changedIds?: readonly string[],
    options?: { skipMcpAdd?: boolean },
  ) => Promise<PluginSyncReport>;
}

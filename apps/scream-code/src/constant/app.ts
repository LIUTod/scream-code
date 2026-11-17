export const PRODUCT_NAME = 'Scream Code';
export const CLI_COMMAND_NAME = 'scream';
// Product constants used in HTTP User-Agent headers.
export const CLI_USER_AGENT_PRODUCT = 'scream-code-cli';
export const CLI_UI_MODE = 'shell';

// App-owned data paths. SDK/core runtime config is intentionally not routed here.

export const SCREAM_CODE_HOME_ENV = 'SCREAM_CODE_HOME';
export const SCREAM_CODE_DATA_DIR_NAME = '.scream-code';
export const SCREAM_CODE_LOG_DIR_NAME = 'logs';
export const SCREAM_CODE_UPDATE_DIR_NAME = 'updates';
export const SCREAM_CODE_UPDATE_STATE_FILE_NAME = 'latest.json';
export const SCREAM_CODE_INPUT_HISTORY_DIR_NAME = 'user-history';
export const SCREAM_CODE_UI_PREFERENCES_FILE_NAME = 'ui-preferences.json';

// Managed Scream auth provider key shared with OAuth/SDK config.
export const DEFAULT_OAUTH_PROVIDER_NAME = 'managed:scream-code';

// GitHub — sole source of truth for the project.
export const SCREAM_CODE_PLUGIN_MARKETPLACE_URL =
  'https://raw.githubusercontent.com/LIUTod/scream-code/main/plugins/marketplace.json';
export const SCREAM_CODE_PLUGIN_MARKETPLACE_URL_ENV = 'SCREAM_CODE_PLUGIN_MARKETPLACE_URL';

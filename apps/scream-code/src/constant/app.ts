import { ErrorCodes } from '@scream-cli/scream-code-sdk';

export const PRODUCT_NAME = 'Scream Code';
export const CLI_COMMAND_NAME = 'scream';

// Used in telemetry app names and HTTP User-Agent headers.
export const CLI_USER_AGENT_PRODUCT = 'scream-code-cli';
export const CLI_UI_MODE = 'shell';

// Give telemetry a short flush window without making CLI exit feel stuck.
export const CLI_SHUTDOWN_TIMEOUT_MS = 3000;

// App-owned data paths. SDK/core runtime config is intentionally not routed here.
export const SCREAM_CODE_HOME_ENV = 'SCREAM_CODE_HOME';
export const SCREAM_CODE_DATA_DIR_NAME = '.scream-code';
export const SCREAM_CODE_LOG_DIR_NAME = 'logs';
export const SCREAM_CODE_UPDATE_DIR_NAME = 'updates';
export const SCREAM_CODE_UPDATE_STATE_FILE_NAME = 'latest.json';
export const SCREAM_CODE_INPUT_HISTORY_DIR_NAME = 'user-history';

// Managed Scream auth provider key shared with OAuth/SDK config.
export const DEFAULT_OAUTH_PROVIDER_NAME = 'managed:scream-code';

// SDK/core error code that tells the TUI to show a login-required startup
// notice. Derived from sdk's ErrorCodes so a future rename in core
// auto-propagates instead of silently breaking the startup recovery path.
export const OAUTH_LOGIN_REQUIRED_CODE = ErrorCodes.AUTH_LOGIN_REQUIRED;

export const FEEDBACK_ISSUE_URL = 'https://github.com/LIUTod/scream-code/issues';

// Sent in the feedback `version` field so the backend can distinguish this
// TypeScript client from clients that send a bare version.
export const FEEDBACK_VERSION_PREFIX = 'scream-code-';

// Telemetry event name; keep stable for dashboard queries.
export const FEEDBACK_TELEMETRY_EVENT = 'feedback_submitted';

// CDN source of truth: all version checks and native install scripts pull from here.
export const SCREAM_CODE_CDN_BASE = 'https://code.scream.com/scream-code';
export const SCREAM_CODE_CDN_LATEST_URL = `${SCREAM_CODE_CDN_BASE}/latest`;
export const SCREAM_CODE_PLUGIN_MARKETPLACE_URL = `${SCREAM_CODE_CDN_BASE}/plugins/marketplace.json`;
export const SCREAM_CODE_PLUGIN_MARKETPLACE_URL_ENV = 'SCREAM_CODE_PLUGIN_MARKETPLACE_URL';
export const SCREAM_CODE_INSTALL_SH_URL = `${SCREAM_CODE_CDN_BASE}/install.sh`;
export const SCREAM_CODE_INSTALL_PS1_URL = `${SCREAM_CODE_CDN_BASE}/install.ps1`;

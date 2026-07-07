import type { HookResultEvent } from '@scream-code/scream-code-sdk';

import { t } from '@scream-code/config';

export function formatHookResultMarkdown(event: HookResultEvent): string {
  return `*${formatHookResultTitle(event)}*\n\n${formatHookResultBody(event)}`;
}

export function formatHookResultPlain(event: HookResultEvent): string {
  return `${formatHookResultTitle(event)}\n\n${formatHookResultBody(event)}`;
}

function formatHookResultTitle(event: HookResultEvent): string {
  return `${event.hookEvent} hook${event.blocked === true ? t('hookresult.blocked') : ''}`;
}

function formatHookResultBody(event: HookResultEvent): string {
  const content = event.content.trim();
  return content.length === 0 ? t('hookresult.empty') : content;
}

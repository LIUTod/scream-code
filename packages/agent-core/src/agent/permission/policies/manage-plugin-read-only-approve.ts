import { MANAGE_PLUGIN_READ_ONLY_ACTIONS } from '../../../tools/builtin/plugin/manage-plugin';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set(MANAGE_PLUGIN_READ_ONLY_ACTIONS);

/**
 * Auto-approves the read-only faces of `ManagePlugin`.
 *
 * Listing and inspecting the plugin table has no side effects, so gating it
 * would only train the model to skip the "look before you add" step the tool
 * exists to enforce. Anything that writes state or runs plugin code decides
 * nothing here and falls through the chain to the ordinary approval prompt.
 *
 * The action is read off the invocation arguments. A missing or unparseable
 * payload decides nothing on purpose, so the fail-open direction is always
 * "ask the user".
 */
export class ManagePluginReadOnlyApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'manage-plugin-read-only-approve';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'ManagePlugin') return;
    const action = readAction(context);
    if (action === undefined || !READ_ONLY_ACTIONS.has(action)) return;
    return {
      kind: 'approve',
      reason: { manage_plugin_action: action },
    };
  }
}

/** Read `action` from the resolved args, falling back to the raw tool-call JSON. */
function readAction(context: PermissionPolicyContext): string | undefined {
  const fromArgs = (context.args as { action?: unknown } | undefined)?.action;
  if (typeof fromArgs === 'string') return fromArgs;
  const rawArguments = context.toolCall.arguments;
  if (typeof rawArguments !== 'string') return undefined;
  try {
    const raw = JSON.parse(rawArguments) as { action?: unknown };
    return typeof raw?.action === 'string' ? raw.action : undefined;
  } catch {
    return undefined;
  }
}

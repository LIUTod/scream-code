import type { Agent } from '..';
import { DynamicInjector } from './injector';

/**
 * Capability-driven MCP usage guides.
 *
 * Instead of matching hard-coded server names, each guide declares which
 * MCP *capability* (resolved by `mcp/capabilities.ts` — explicit config
 * declaration or built-in fingerprint) activates it. One injector instance
 * per guide keeps the base class's single-slot `injectedAt` lifecycle math
 * (compaction / undo tracking) intact for every capability independently.
 */

export interface McpCapabilityGuide {
  /** Capability label from the config layer, e.g. `browser`. */
  readonly capability: string;
  /** Stable variant id surfaced on the injected system-reminder. */
  readonly variant: string;
  readonly text: string;
}

const BROWSER_SKILL_GUIDANCE = `\
## Browser Automation (chrome-devtools-mcp)

A Chrome DevTools MCP server is connected (\`mcp__chrome_devtools__*\` tools).
It drives a live Chrome instance for testing, debugging and performance
analysis. Every page-scoped tool needs its \`pageId\`; use \`list_pages\` to
see which pages exist.

### Golden rules
- \`take_snapshot\` (ARIA tree) before any interaction — \`click\` / \`fill\` /
  \`hover\` target the \`uid\`s it returns.
- **Snapshot uids go stale after navigation or major DOM changes.** Always
  \`take_snapshot\` again right before acting; reusing uids from the previous
  page is the most common failure.
- Screenshots: pass \`filePath\` to save to disk, then read the file only if
  you must inspect it — inline images burn context. The server already
  downscales and compresses screenshots for you.
- After a navigation, verify page health with \`list_console_messages\`
  (JS errors) and \`list_network_requests\` (failed loads).
- Close pages you no longer need with \`close_page\`.

### Task → tool map
- Open / manage pages: \`navigate_page\`, \`new_page\`, \`list_pages\`,
  \`select_page\`, \`close_page\`, \`resize_page\`
- Read state: \`take_snapshot\`, \`evaluate_script\` (arbitrary in-page JS),
  \`take_screenshot\`, \`wait_for\`
- Interact: \`click\`, \`fill\`, \`fill_form\` (batch — prefer over many fills),
  \`type_text\`, \`press_key\`, \`hover\`, \`drag\`, \`upload_file\`,
  \`handle_dialog\`
- Debug: \`list_console_messages\`, \`get_console_message\`,
  \`list_network_requests\`, \`get_network_request\`
- Performance & memory: \`performance_start_trace\`, \`performance_stop_trace\`,
  \`performance_analyze_insight\`, \`lighthouse_audit\`, \`take_heapsnapshot\`,
  \`emulate\` (network/CPU throttling, dark mode, mobile viewports)

### Local dev preview workflow
Use this whenever a local dev server backs a UI change (vite/next/webpack…):
1. Start the server in the background (e.g. \`pnpm dev\`) and note its port.
2. \`new_page\` → \`navigate_page\` to \`http://localhost:<port>\`.
3. Verify health before eyeballing: \`list_console_messages\` (JS errors) +
   \`list_network_requests\` (404s / failed modules).
4. \`take_snapshot\` for structure, \`take_screenshot\` (with \`filePath\`) for
   visual acceptance of the changed part.
5. After further code edits, \`navigate_page\` type=\`reload\` and repeat
   steps 3-4; HMR usually applies without a reload.

### When to use
- Test a localhost app → navigate + screenshot + console check
- Debug frontend issues → console errors + network requests
- Verify a UI change → screenshot before/after
- Walk a form flow → fill_form + click + wait_for + screenshot
- Page performance questions → performance_start_trace
- Do NOT use for simple HTTP data fetching — prefer FetchURL.`;

export const MCP_CAPABILITY_GUIDES: readonly McpCapabilityGuide[] = [
  {
    capability: 'browser',
    // Variant id kept from the pre-capability era for wire/UI stability.
    variant: 'mcp_browser_skill',
    text: BROWSER_SKILL_GUIDANCE,
  },
];

class McpCapabilityGuideInjector extends DynamicInjector {
  protected override readonly injectionVariant: string;

  constructor(agent: Agent, private readonly guide: McpCapabilityGuide) {
    super(agent);
    this.injectionVariant = guide.variant;
  }

  getInjection(): string | undefined {
    if (this.injectedAt !== null) return undefined;
    const mcp = this.agent.mcp;
    if (!mcp) return undefined;
    const active = mcp
      .list()
      .some(
        (entry) =>
          entry.status === 'connected' &&
          entry.capabilities.includes(this.guide.capability),
      );
    if (!active) return undefined;
    return this.guide.text;
  }
}

/** One injector per registered capability guide. */
export function createMcpCapabilityGuideInjectors(agent: Agent): DynamicInjector[] {
  return MCP_CAPABILITY_GUIDES.map((guide) => new McpCapabilityGuideInjector(agent, guide));
}

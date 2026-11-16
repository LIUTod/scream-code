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
 *
 * The browser text is written against chrome-devtools-mcp 1.13 (the version
 * the `/mcp` recommendation installs via `@latest`). Tool names are the
 * server's own; anything the built-in recommendation does not enable is
 * described as opt-in instead of assumed present.
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

A Chrome DevTools MCP server is connected (\`mcp__chrome-devtools__*\` tools).
Its tools are **on-demand**: the schemas are withheld to keep requests lean.
Enable the ones you need first — \`DiscoverMcpTools({ server: "chrome-devtools" })\`
lists them, then \`DiscoverMcpTools({ tools: [...] })\` makes them callable from
the next step on.
It drives a live Chrome instance. Every page-scoped tool needs a \`pageId\`:
\`list_pages\` shows the open pages and their ids.
Some capabilities ship as opt-in server flags (\`mock_network\`, heap analysis). If
a tool named below is missing from the list, the server was started without its
category — work with what is listed and say so instead of inventing a call.

### Golden rules
- \`take_snapshot\` (a11y tree) before any interaction — \`click\` / \`fill\` /
  \`hover\` target the \`uid\`s it returns.
- **uids go stale after navigation or a major DOM change.** Re-snapshot right
  before acting instead of reusing uids from an earlier turn.
- \`file:\` navigations are rejected by this server on purpose: it is not a
  filesystem boundary. Serve the page over \`http://localhost\` instead.
- Do not edit the app to observe runtime values — \`set_logpoints\` logs
  expressions at script/source-map lines into \`list_console_messages\`.

### Reading state
- Structure: \`take_snapshot\` (\`verbose\` for full attribute detail, \`filePath\`
  to keep it off-context). To wait for content, use \`wait_for\` (\`texts\` +
  \`visible\`) rather than snapshotting in a loop.
- Visual: \`take_screenshot\` — JPEG by default here; \`uid\` for one element,
  \`fullPage: true\` for the whole document, \`filePath\` to save to disk.
- Console: \`list_console_messages\` (\`types\`, \`pageIdx\`/\`pageSize\`,
  \`includeStackTraces\`; \`includePreservedMessages\` reaches back over the last
  navigations). Objects print as \`[object Object]\` — read one entry with
  \`get_console_message\`.
- Network: \`list_network_requests\` (\`resourceTypes\`, \`pageIdx\`/\`pageSize\`,
  \`includePreservedRequests\`); headers and bodies of one request via
  \`get_network_request\` — pass \`requestFilePath\`/\`responseFilePath\` to write
  bodies to disk instead of into the context.
- Styles: \`get_css_styles\` returns matched rules, inherited styles, custom
  properties and cascade wrappers for one element; treat it as authoritative and
  page through it with \`pageIdx\`.

### Driving the page
- Pages: \`navigate_page\` (URL, or \`back\`/\`forward\`/\`reload\`), \`new_page\`,
  \`select_page\`, \`close_page\`, \`resize_page\`.
- Input: \`fill_form\` for several fields at once (prefer over repeated \`fill\`),
  then \`fill\`, \`click\`, \`hover\`, \`drag\`, \`press_key\`, \`type_text\`,
  \`upload_file\`. A JS dialog blocks other tools until \`handle_dialog\` answers it.
- JS: \`evaluate_script\` — inline \`function\` (default, accepts element uids as
  \`args\`) or a script name, \`sourcePath\` for a script file, \`filePath\` to
  write the result to disk instead of into the context.
- Emulation: \`emulate\` — **each call replaces all emulation settings**
  (throttling, CPU, geolocation, user agent, dark mode, media features, viewport)
  **except \`extraHttpHeaders\`**, which accumulate; pass everything you want in
  one call.
- Mocks: \`mock_network\` / \`remove_network_mock\` for page-scoped routes (error
  and empty states, canned payloads). Configure before navigating or reloading; a
  mock disables the page HTTP cache while it is active. It cannot inject latency
  — for a slow network use \`emulate\` network conditions.
- Video: \`screencast_start\` → \`screencast_stop\` (mp4) to capture a multi-step
  repro.

### Performance, audits, memory
- \`performance_start_trace\` → interact → \`performance_stop_trace\`, then
  \`performance_analyze_insight\` on one insight at a time.
- \`lighthouse_audit\` returns accessibility/SEO/best-practices/agentic scores plus
  failing audits and the DOM nodes they flag; full reports are written to disk.
  It **excludes performance** — use the trace tools for that.
- Memory: \`take_heapsnapshot\`, then the \`get_heapsnapshot_*\` /
  \`analyze_heapsnapshot_contexts\` / \`compare_heapsnapshots\` tools.

### Keep context lean
- Leave \`includeSnapshot\` off on action calls; request a snapshot only when you
  need to observe the result.
- Filter and paginate instead of dumping: \`types\`, \`resourceTypes\`,
  \`pageIdx\`/\`pageSize\`; send snapshots, traces and bodies to \`filePath\`.
- Close pages you are done with (\`close_page\`); the last page cannot be closed.

### Batch multi-step flows with RunScript
When \`RunScript\` is available, a deterministic multi-step flow (navigate → snapshot
→ fill → click → verify) is one scripted batch call: inside the script
\`await tools['mcp__chrome-devtools__click']({...})\` (the server name keeps its
hyphen, so bracket access is required), keep raw snapshots in the sandbox,
and return only a summary through \`text(...)\` (console errors, matched elements,
counts, screenshot paths). Re-take the snapshot inside the script before acting —
uids go stale. Without \`RunScript\`, call the tools step by step; likewise for single
actions, or when each step depends on observing the previous result.

### Local dev preview workflow
1. Start the dev server in the background (e.g. \`pnpm dev\`) and note its port.
2. \`new_page\` → \`navigate_page\` to \`http://localhost:<port>\`.
3. Check health before eyeballing: \`list_console_messages\` (JS errors) +
   \`list_network_requests\` (404s / failed modules).
4. \`take_snapshot\` for structure, \`take_screenshot\` with \`filePath\` for
   visual acceptance of the changed part; inspect the file with \`ReadMediaFile\`.
5. After further edits, \`navigate_page\` type=\`reload\` and repeat 3-4; HMR
   usually applies without a reload.
6. When a rule behaves unexpectedly, reach for \`get_css_styles\`; when a value
   is unclear, \`set_logpoints\` instead of adding console.log to the source.

### When to use
- Test a localhost app → navigate + screenshot + console check
- Debug frontend issues → console errors + network requests + breakpoints/logpoints
- Verify a UI change → screenshot before/after
- Walk a form flow → fill_form + click + wait_for + screenshot
- Page performance questions → performance trace (lighthouse_audit excludes performance)
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

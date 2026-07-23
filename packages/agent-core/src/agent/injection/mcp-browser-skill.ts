import type { Agent } from '..';
import { DynamicInjector } from './injector';

const BROWSER_SKILL_GUIDANCE = `\
## Browser Automation (chrome-devtools-mcp)

You have chrome-devtools-mcp tools available (\`mcp__chrome_devtools__*\`).
These give you full control over a Chrome browser instance so you can test,
debug, and inspect web pages directly.

### Navigation & Pages
- \`navigate_page\` — Go to a URL
- \`new_page\` / \`close_page\` / \`list_pages\` / \`select_page\` — Manage tabs

### Inspecting the Page
- \`take_snapshot\` — Full ARIA accessibility tree (best for understanding page structure)
- \`take_screenshot\` — Capture visual screenshot (element, viewport, or full page)
- \`evaluate_script\` — Execute arbitrary JS in the page (e.g. \`document.title\`, \`window.scrollBy()\`)
- \`list_console_messages\` / \`get_console_message\` — Read console logs and errors
- \`list_network_requests\` / \`get_network_request\` — Inspect HTTP traffic

### Interacting with the Page
- \`click\` / \`hover\` / \`press_key\` / \`type_text\` / \`fill\` / \`fill_form\` — Interact with elements
- \`drag\` — Drag and drop elements
- \`wait_for\` — Wait for text/element to appear before acting
- \`upload_file\` — Attach local files to file inputs
- \`handle_dialog\` — Accept or dismiss browser dialogs (alert/confirm/prompt)

### Performance & Debugging
- \`performance_start_trace\` / \`performance_stop_trace\` / \`performance_analyze_insight\` — Record and analyze page load performance
- \`lighthouse_audit\` — Run a full Lighthouse audit
- \`emulate\` — Emulate device metrics, user agent, or CPU throttling

### Usage Pattern
1. \`navigate_page\` to the target URL
2. \`take_snapshot\` to understand the page structure and find element UIDs
3. \`click\` / \`fill\` / \`type_text\` to interact using snapshot UIDs
4. \`take_screenshot\` to verify the visual result
5. \`list_console_messages\` to check for JS errors

### When to Use
- User asks to test a localhost app → navigate + screenshot + console check
- User asks to debug frontend issues → check console errors + network requests
- User asks to verify UI changes → screenshot before/after
- User asks to test a form flow → fill + click + wait_for + screenshot
- User asks to check page performance → performance_start_trace
- Do NOT use for simple HTTP data fetching — prefer FetchURL for that.

### Notes
- Use \`take_snapshot\` before interacting — it provides stable element UIDs for click/fill
- \`evaluate_script\` can do anything JS can (scroll, read DOM, trigger events)
- Close pages you no longer need with \`close_page\` to manage memory`;

const MCP_SERVER_NAME = 'chrome-devtools';

export class McpBrowserSkillInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'mcp_browser_skill';

  constructor(agent: Agent) {
    super(agent);
  }

  getInjection(): string | undefined {
    if (this.injectedAt !== null) return undefined;
    const mcp = this.agent.mcp;
    if (!mcp) return undefined;
    const entries = mcp.list();
    const connected = entries.some(
      (e) => e.status === 'connected' && e.name === MCP_SERVER_NAME,
    );
    if (!connected) return undefined;
    return BROWSER_SKILL_GUIDANCE;
  }
}

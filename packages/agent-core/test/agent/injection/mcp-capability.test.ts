import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { PromptOrigin } from '../../../src/agent/context';
import {
  createMcpCapabilityGuideInjectors,
  MCP_CAPABILITY_GUIDES,
} from '../../../src/agent/injection/mcp-capability-guides';
import { resolveServerCapabilities } from '../../../src/mcp/capabilities';
import type { McpServerEntry } from '../../../src/mcp/connection-manager';

function entry(
  name: string,
  capabilities: readonly string[],
  status: McpServerEntry['status'] = 'connected',
): McpServerEntry {
  return { name, transport: 'stdio', status, toolCount: 1, error: undefined, capabilities };
}

function guideAgent(entries: readonly McpServerEntry[]) {
  const history: Array<{ content: string; origin: PromptOrigin }> = [];
  const agent = {
    mcp: { list: () => entries },
    context: {
      history,
      appendSystemReminder: (content: string, origin: PromptOrigin) => {
        history.push({ content, origin });
      },
    },
  };
  return { agent: agent as unknown as Agent, history };
}

const browserGuide = MCP_CAPABILITY_GUIDES.find((g) => g.capability === 'browser');

describe('capability-driven MCP guide injection', () => {
  it('injects the browser guide for a renamed server with an explicit capability (no name hard-coding)', async () => {
    const { agent, history } = guideAgent([entry('my-browser-tools', ['browser'])]);
    for (const injector of createMcpCapabilityGuideInjectors(agent)) {
      await injector.inject();
    }
    expect(history).toHaveLength(1);
    expect(history[0]?.content).toContain('Browser Automation');
    expect(history[0]?.origin).toEqual({ kind: 'injection', variant: 'mcp_browser_skill' });
  });

  it('still injects for an undeclared chrome-devtools entry via fingerprint, with byte-identical text', async () => {
    // Simulates the connection-manager pipeline: config has no capabilities
    // key, entry carries the fingerprint-resolved value.
    const caps = resolveServerCapabilities('chrome-devtools', {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest'],
    });
    expect(caps).toEqual(['browser']);
    const { agent, history } = guideAgent([entry('chrome-devtools', caps)]);
    for (const injector of createMcpCapabilityGuideInjectors(agent)) {
      await injector.inject();
    }
    expect(history).toHaveLength(1);
    // Zero-drift anchor: text comes verbatim from the registry.
    expect(history[0]?.content).toBe(browserGuide?.text);
  });

  it('does not inject when capabilities were explicitly opted out ([])', async () => {
    const { agent, history } = guideAgent([entry('chrome-devtools', [])]);
    for (const injector of createMcpCapabilityGuideInjectors(agent)) {
      await injector.inject();
    }
    expect(history).toHaveLength(0);
  });

  it('does not inject while the server is not connected', async () => {
    const { agent, history } = guideAgent([entry('chrome-devtools', ['browser'], 'pending')]);
    for (const injector of createMcpCapabilityGuideInjectors(agent)) {
      await injector.inject();
    }
    expect(history).toHaveLength(0);
  });

  it('stays silent (no throw) for capabilities without a registered guide', async () => {
    const { agent, history } = guideAgent([entry('scream-life', ['memory'])]);
    for (const injector of createMcpCapabilityGuideInjectors(agent)) {
      await injector.inject();
    }
    expect(history).toHaveLength(0);
  });

  it('injects once per instance and creates one injector per guide', async () => {
    const { agent, history } = guideAgent([entry('chrome-devtools', ['browser'])]);
    const injectors = createMcpCapabilityGuideInjectors(agent);
    expect(injectors).toHaveLength(MCP_CAPABILITY_GUIDES.length);
    for (const injector of injectors) {
      await injector.inject();
      await injector.inject();
    }
    expect(history).toHaveLength(1);
  });
});

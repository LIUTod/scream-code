import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { dirname, join } from 'pathe';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ScreamError } from '../../src/errors';
import { StdioMcpClient } from '../../src/mcp/client-stdio';

const here = import.meta.dirname;
const fixture = join(here, 'fixtures', 'mock-stdio-server.mjs');
const stderrThenExitFixture = join(here, 'fixtures', 'stderr-then-exit-stdio-server.mjs');
const crashAfterConnectFixture = join(here, 'fixtures', 'crash-after-connect-stdio-server.mjs');

/** The fixture's `client_roots` tool replies with a single text block. */
function firstText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('StdioMcpClient', () => {
  it('rejects unsupported executor at construction time', () => {
    expect(
      () =>
        new StdioMcpClient({
          transport: 'stdio',
          command: 'true',
          executor: 'jian',
        }),
    ).toThrow(
      expect.objectContaining({ name: 'ScreamError', code: 'not_implemented' }) as unknown as Error,
    );
    // Sanity-check the error class identity too.
    let thrown: unknown;
    try {
      const client = new StdioMcpClient({ transport: 'stdio', command: 'true', executor: 'jian' });
      void client;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ScreamError);
  });

  it('connects, lists tools, and round-trips a text result', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name).toSorted()).toEqual([
        'boom',
        'client_roots',
        'echo',
        'read_env',
      ]);
      const echo = tools.find((t) => t.name === 'echo');
      expect(echo?.description).toBe('Echoes input text');
      expect(echo?.inputSchema).toMatchObject({ type: 'object' });

      const result = await client.callTool('echo', { text: 'hello mcp' });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: 'hello mcp' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('answers roots/list when a roots provider is configured', async () => {
    const rootA = join(tmpdir(), 'scream-roots-a');
    const rootB = join(tmpdir(), 'scream-roots-b');
    const provided = [`${rootA}/`, rootA, rootB];
    const client = new StdioMcpClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [fixture],
      },
      { rootsProvider: () => provided },
    );
    try {
      await client.connect();
      const result = await client.callTool('client_roots', {});
      expect(result.isError).toBe(false);
      // The trailing slash and the repeat both normalise to one root, and
      // paths arrive as `file://` URIs — the MCP schema rejects plain paths.
      expect(JSON.parse(firstText(result))).toEqual([
        { uri: pathToFileURL(rootA).href, name: basename(rootA) },
        { uri: pathToFileURL(rootB).href, name: basename(rootB) },
      ]);
      // The provider is consulted per request — not captured at construction —
      // so a provider tracking the live workspace needs no reconnect.
      provided.splice(0, provided.length, rootB);
      const second = await client.callTool('client_roots', {});
      expect(JSON.parse(firstText(second))).toEqual([
        { uri: pathToFileURL(rootB).href, name: basename(rootB) },
      ]);
      // A filesystem root has an empty basename: `name` is omitted (it is
      // optional in the MCP schema) rather than sent as an empty string.
      provided.splice(0, provided.length, '/');
      const rootOnly = await client.callTool('client_roots', {});
      expect(JSON.parse(firstText(rootOnly))).toEqual([{ uri: pathToFileURL('/').href }]);
      // A POSIX directory name may contain a literal backslash: normalisation
      // must use the platform's own rules. A cross-platform helper rewrites it
      // into a separator (`.../scream-roots-a/b`, name `b`) and points the root
      // at a directory that does not exist — which is how workspace writes get
      // rejected. Both sides of the expectation are computed with the platform's
      // own path functions, so a Windows runner degrades to ordinary subdirectory
      // semantics instead of a false red.
      const backslashRoot = `${rootA}\\b`;
      provided.splice(0, provided.length, backslashRoot);
      const backslash = await client.callTool('client_roots', {});
      expect(JSON.parse(firstText(backslash))).toEqual([
        { uri: pathToFileURL(backslashRoot).href, name: basename(resolve(backslashRoot)) },
      ]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('does not answer roots/list when no roots provider is configured', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    try {
      await client.connect();
      const result = await client.callTool('client_roots', {});
      // No `roots` capability was declared, so no handler is registered and
      // the SDK answers the server's request with Method not found. Match the
      // JSON-RPC code as well — the wording is SDK-owned.
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/-32601|Method not found/);
    } finally {
      await client.close();
    }
  }, 15000);

  it('propagates server-reported isError', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    try {
      await client.connect();
      const result = await client.callTool('boom', {});
      expect(result.isError).toBe(true);
      expect(result.content[0]).toEqual({ type: 'text', text: 'boom!' });
    } finally {
      await client.close();
    }
  }, 15000);

  it('forwards configured env to the spawned server', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: { SCREAM_TEST_ENV: 'forwarded-value' },
    });
    try {
      await client.connect();
      const result = await client.callTool('read_env', { name: 'SCREAM_TEST_ENV' });
      expect(result.content).toEqual([{ type: 'text', text: 'forwarded-value' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('forwards allowlisted env vars; config.env overrides on conflict', async () => {
    // Use TERM prefix which is in the allowlist.
    const parentOnly = `TERM_SCREAM_TEST_PARENT_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const shared = `TERM_SCREAM_TEST_SHARED_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    process.env[parentOnly] = 'from-parent';
    process.env[shared] = 'from-parent';
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: { [shared]: 'from-config' },
    });
    try {
      await client.connect();
      const inherited = await client.callTool('read_env', { name: parentOnly });
      expect(inherited.content).toEqual([{ type: 'text', text: 'from-parent' }]);
      const overridden = await client.callTool('read_env', { name: shared });
      expect(overridden.content).toEqual([{ type: 'text', text: 'from-config' }]);
    } finally {
      delete process.env[parentOnly];
      delete process.env[shared];
      await client.close();
    }
  }, 15000);

  it('does not forward non-allowlisted env vars', async () => {
    const secret = `SCREAM_TEST_SECRET_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    process.env[secret] = 'should-not-leak';
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    try {
      await client.connect();
      const result = await client.callTool('read_env', { name: secret });
      expect(result.content).toEqual([{ type: 'text', text: '' }]);
    } finally {
      delete process.env[secret];
      await client.close();
    }
  }, 15000);

  it('captures recent stderr into a snapshot the manager can attach to errors', async () => {
    const banner = `scream-test-stderr-${Date.now()}`;
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stderrThenExitFixture],
      env: { SCREAM_TEST_MCP_STDERR: banner },
    });
    try {
      await expect(client.connect()).rejects.toThrow();
      // Even when connect fails, the buffered stderr must be retrievable so
      // higher layers can include it in the user-facing error message.
      expect(client.stderrSnapshot()).toContain(banner);
    } finally {
      await client.close();
    }
  }, 15000);

  it('keeps the stderr buffer bounded so noisy servers cannot exhaust memory', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    try {
      await client.connect();
      // Confirm the buffer cap is documented and finite (4 KB is plenty for a
      // useful tail). The exact value is an implementation detail but
      // exposing it for tests prevents unbounded growth from regressing.
      expect(StdioMcpClient.stderrBufferCapacity).toBeLessThanOrEqual(16 * 1024);
      expect(StdioMcpClient.stderrBufferCapacity).toBeGreaterThanOrEqual(1024);
    } finally {
      await client.close();
    }
  }, 15000);

  it('notifies an unexpected-close listener when the child exits after connect', async () => {
    const banner = `scream-test-crash-${Date.now()}`;
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [crashAfterConnectFixture],
      env: { SCREAM_TEST_MCP_EXIT_AFTER_MS: '50', SCREAM_TEST_MCP_STDERR: banner },
    });
    const closes: Array<{ stderr?: string; error?: string }> = [];
    client.onUnexpectedClose((reason) => {
      closes.push({ stderr: reason.stderr, error: reason.error?.message });
    });
    try {
      await client.connect();
      // Wait for the child to exit and onclose to fire.
      for (let i = 0; i < 100; i++) {
        if (closes.length > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(closes).toHaveLength(1);
      expect(closes[0]?.stderr ?? '').toContain(banner);
    } finally {
      await client.close();
    }
  }, 15000);

  it('buffers an early close and replays it on listener registration', async () => {
    const banner = `scream-test-early-${Date.now()}`;
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [crashAfterConnectFixture],
      env: { SCREAM_TEST_MCP_STDERR: banner, SCREAM_TEST_MCP_EXIT_CODE: '0' },
    });
    try {
      await client.connect();
      // Drive the child to exit AFTER a successful tool response. The fixture
      // schedules `process.exit` via setImmediate so the reply is fully
      // flushed before the pipe closes; this exercises the post-handshake
      // disconnect path with no startup-timing race.
      const reply = await client.callTool('exit_after_reply', {});
      expect(reply.isError).toBe(false);
      // Wait deterministically for the child to actually exit. The fixture
      // writes `banner\n` to stderr sync-before `process.exit`, so observing
      // the banner is proof the exit syscall has been issued.
      const exitDeadline = Date.now() + 5000;
      while (Date.now() < exitDeadline && !client.stderrSnapshot().includes(banner)) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(client.stderrSnapshot()).toContain(banner);
      // Drain probe: send a fresh request that the dead transport must
      // reject. Once it does, we know the SDK has processed `_onclose`,
      // which means our hook has already populated `pendingUnexpectedClose`.
      // This is what gives us a buffer to replay — registering the listener
      // first would intercept the close as a live fire instead.
      const drainDeadline = Date.now() + 5000;
      let transportConfirmedDead = false;
      while (Date.now() < drainDeadline) {
        try {
          await client.callTool('echo', { text: 'probe' });
        } catch {
          transportConfirmedDead = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(transportConfirmedDead).toBe(true);
      // `pendingUnexpectedClose` is set; registering the listener must
      // invoke it synchronously inside the call.
      let received: { stderr?: string } | undefined;
      let syncedOnRegister = false;
      client.onUnexpectedClose((reason) => {
        syncedOnRegister = true;
        received = { stderr: reason.stderr };
      });
      expect(syncedOnRegister).toBe(true);
      expect(received?.stderr ?? '').toContain(banner);
    } finally {
      await client.close();
    }
  }, 15000);

  it('does not fire unexpected-close when the caller closes the client itself', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    const closes: number[] = [];
    client.onUnexpectedClose(() => closes.push(Date.now()));
    await client.connect();
    await client.close();
    // Give any pending onclose listener a chance to fire so we are sure it is
    // suppressed and not merely racing.
    await new Promise((r) => setTimeout(r, 100));
    expect(closes).toEqual([]);
  }, 15000);

  it('killSync terminates the child process synchronously', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    try {
      await client.connect();
      const pid = (
        client as unknown as { transport: { pid: number | null } }
      ).transport.pid;
      expect(pid).toBeGreaterThan(0);

      client.killSync();
      // The signal is delivered asynchronously; give the OS a moment.
      await new Promise((r) => setTimeout(r, 150));
      // process.kill(pid, 0) throws ESRCH once the process is gone.
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      await client.close();
    }
  }, 15000);
});

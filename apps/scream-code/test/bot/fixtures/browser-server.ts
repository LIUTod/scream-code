/**
 * Live browser acceptance gateway. Only the HTTP model provider is controlled;
 * sessions, RPC, tools, persistence, REST/SSE and the built UI are production code.
 *
 * From the repository root (no build is performed):
 *   pnpm exec tsx --import ./build/register-raw-text-loader.mjs \
 *     apps/scream-code/test/bot/fixtures/browser-server.ts --port 3219
 *
 * Scenarios are explicit messages: [[browser:stream]], [[browser:slow-a]],
 * [[browser:slow-b]], [[browser:stop]], [[browser:ask]], [[browser:ask-multi]],
 * [[browser:file]], [[browser:tool-failure]], [[browser:provider-error]],
 * [[browser:handoff]]. Unknown messages get a deterministic streamed answer.
 *
 * --root <node_modules/.cache/...> --keep-state preserves the SAME home and DB
 * for a restart/recovery journey. SIGKILL naturally preserves state too. Without
 * --keep-state, SIGINT/SIGTERM removes home/workspace, retaining artifacts only.
 * --home/--workspace may select distinct direct children of the fixture root.
 * Never point this process at real user state. It refuses non-cache roots and
 * existing unmarked directories. This fixture never executes shell/model code.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { directoryWithoutSymlink, FixtureFiles, within } from './browser-isolation';

const repo = path.resolve(import.meta.dirname, '../../../../..');
const cache = path.join(repo, 'node_modules', '.cache');
const MODEL = 'browser-test';
const MARKER = 'scream-live-browser-fixture-v1';
const HELP = `Usage: pnpm exec tsx --import ./build/register-raw-text-loader.mjs apps/scream-code/test/bot/fixtures/browser-server.ts
  --root <dir>       Isolated root under this repository's node_modules/.cache
  --home <dir>       Home (direct child of root; default root/home)
  --workspace <dir>  Workspace (direct child of root; default root/workspace)
  --port <0..65535>  Gateway port (default 3219; 0 chooses a free port)
  --provider-port <0..65535>  Model port (default 0)
  --keep-state       Preserve home/workspace for recovery on next launch
`;

interface Options {
  root?: string;
  home?: string;
  workspace?: string;
  port: number;
  providerPort: number;
  keepState: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = { port: 3219, providerPort: 0, keepState: false };
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === '--help' || key === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    }
    if (key === '--keep-state') {
      options.keepState = true;
      continue;
    }
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (key === '--root') options.root = path.resolve(value);
    else if (key === '--home') options.home = path.resolve(value);
    else if (key === '--workspace') options.workspace = path.resolve(value);
    else if (key === '--port' || key === '--provider-port') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid ${key}`);
      if (key === '--port') options.port = port;
      else options.providerPort = port;
    } else throw new Error(`Unknown argument: ${key}`);
  }
  return options;
}

interface WireMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}
interface CompletionRequest {
  model?: string;
  stream?: boolean;
  messages: WireMessage[];
  tools?: { function?: { name?: string } }[];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: unknown) => {
    if (typeof part !== 'object' || part === null) return '';
    const text = (part as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }).join('\n');
}

async function listen(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Listener did not bind');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => {
    if (error !== undefined && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
    else resolve();
  }));
}

/** An actual local OpenAI-compatible streaming HTTP endpoint, not a Session fake. */
function createProvider(workspace: string, log: (event: unknown) => void): Server {
  let requests = 0;
  const active = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    if (request.url === '/v1/models' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'local-test' }] }));
      return;
    }
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.on('data', (data: Buffer) => {
      body += data.toString();
      if (body.length > 4_000_000) request.destroy(new Error('Fixture model request too large'));
    });
    request.on('error', (error) => { log({ type: 'provider.request-error', message: error.message }); });
    request.on('end', () => {
      void respond().catch((error: unknown) => {
        log({ type: 'provider.error', message: String(error) });
        if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' });
        if (!response.destroyed) response.end(JSON.stringify({ error: { message: String(error), type: 'invalid_request_error' } }));
      });
    });

    async function respond(): Promise<void> {
      const input = JSON.parse(body) as CompletionRequest;
      if (!Array.isArray(input.messages) || input.model !== MODEL || input.stream !== true) {
        throw new Error('Expected browser-test streaming chat completion');
      }
      requests += 1;
      if (requests > 200) throw new Error('Fixture request limit reached; refusing an uncontrolled loop');
      const id = `browser_completion_${requests}`;
      // Core appends system reminders as user-role messages after the actual
      // prompt (and after tool results). They are not another scenario/turn.
      const userText = (message: WireMessage) => textOf(message.content)
        .replaceAll(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
        .replaceAll(/<system>[\s\S]*?<\/system>/g, '').trim();
      const lastUserIndex = input.messages.findLastIndex((message) => message.role === 'user' && userText(message).length > 0);
      const prompt = lastUserIndex < 0 ? '' : userText(input.messages[lastUserIndex]!);
      const markers = [...prompt.matchAll(/\[\[browser:([a-z-]+)\]\]/g)].map((match) => match[1]);
      // A quoted relay must never redispatch the source's handoff instruction.
      // A relayed answer is its own turn with no marker of its own.
      const isRelay = prompt.includes('[handoff result]') || prompt.includes('[handoff failed]');
      const scenario = markers.includes('peer-result') || isRelay ? 'peer-result' : markers.at(-1) ?? 'stream';
      const tail = input.messages.slice(lastUserIndex + 1);
      const calls = tail.flatMap((message) => message.tool_calls ?? []);
      const results = tail.filter((message) => message.role === 'tool');
      const completed = (name: string) => results.some((result) => calls.some((call) => call.id === result.tool_call_id && call.function.name === name));
      const tools = new Set(input.tools?.map((tool) => tool.function?.name));
      log({ type: 'provider.request', id, scenario, completedTools: calls.filter((call) => results.some((result) => result.tool_call_id === call.id)).map((call) => call.function.name) });

      if (scenario === 'provider-error') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Controlled browser acceptance provider failure (non-retryable).', type: 'invalid_request_error', code: 'browser_test_failure' } }));
        return;
      }
      if (calls.length > 6) throw new Error('Fixture tool-step limit reached');
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      active.add(response);
      const controller = new AbortController();
      response.once('close', () => {
        controller.abort();
        active.delete(response);
        log({ type: 'provider.closed', id });
      });
      const pause = async (ms: number): Promise<boolean> => {
        try { await delay(ms, undefined, { signal: controller.signal }); return true; }
        catch { return false; }
      };
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => {
        if (response.destroyed || response.writableEnded) return;
        response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      };
      const end = (reason: string) => {
        if (response.destroyed || response.writableEnded) return;
        chunk({}, reason);
        response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: MODEL, choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\n\n`);
        response.end('data: [DONE]\n\n');
      };
      const text = async (value: string, interval = 90) => {
        const pieces = value.match(/[\s\S]{1,18}/g) ?? [];
        for (const piece of pieces) {
          if (!(await pause(interval))) return;
          chunk({ content: piece });
        }
        end('stop');
      };
      const tool = async (name: string, args: Record<string, unknown>) => {
        if (!tools.has(name)) {
          await text(`Scenario unavailable: the actual session did not advertise ${name}. No tool was simulated.`);
          return;
        }
        chunk({ content: `Running ${name} through the real session.\n` });
        chunk({ tool_calls: [{ index: 0, id: `call_${requests}_${name}`, type: 'function', function: { name, arguments: '' } }] });
        const argumentsJson = JSON.stringify(args);
        for (let offset = 0; offset < argumentsJson.length; offset += 24) {
          if (!(await pause(65))) return;
          chunk({ tool_calls: [{ index: 0, function: { arguments: argumentsJson.slice(offset, offset + 24) } }] });
        }
        end('tool_calls');
      };
      chunk({ role: 'assistant' });
      if ((scenario === 'ask' || scenario === 'ask-multi') && !completed('AskUserQuestion')) {
        await tool('AskUserQuestion', { questions: [{ question: 'Which acceptance option should be used?', header: 'Browser test', options: [{ label: 'Alpha', description: 'First deterministic option' }, { label: 'Beta', description: 'Second deterministic option' }], multi_select: scenario === 'ask-multi' }] });
      } else if (scenario === 'handoff' && !completed('message_bot')) {
        await tool('message_bot', { to: 'Peer', task: '[[browser:peer-result]] Return the deterministic peer result; do not hand off again.', expecting: 'A plain-text peer result.' });
      } else if (scenario === 'peer-result') {
        await text('Peer result: acceptance handoff executed in a real independent session. No further handoff requested.');
      } else if (scenario === 'file' && !completed('Write')) {
        await tool('Write', { path: path.join(workspace, 'fixture-note.txt'), content: 'Live browser fixture: written by the real Write tool.\n', mode: 'overwrite' });
      } else if (scenario === 'file' && !completed('Read')) {
        await tool('Read', { path: path.join(workspace, 'fixture-note.txt') });
      } else if (scenario === 'tool-failure' && !completed('Read')) {
        // A controlled missing test path yields a real tool error without any write.
        await tool('Read', { path: path.join(workspace, `missing-fixture-file-${process.pid}.txt`) });
      } else if (results.length > 0) {
        const output = results.map((result) => textOf(result.content)).join('\n');
        await text(`Scenario ${scenario}: real tool response received.\n\n${output.slice(0, 3000)}\n\nTool scenario finished.`);
      } else if (scenario === 'slow-a' || scenario === 'slow-b' || scenario === 'stop') {
        const count = scenario === 'stop' ? 180 : 14;
        for (let piece = 1; piece <= count; piece += 1) {
          if (!(await pause(500))) return;
          chunk({ content: `${scenario} piece ${piece}/${count}. ` });
        }
        chunk({ content: `\n${scenario} completed.` });
        end('stop');
      } else {
        await text('Live browser stream completed.\n\n## Acceptance result\n\n- Real HTTP provider\n- Real session execution\n- Persisted transcript\n\n```text\nstreaming fixture response\n```\n\n| Check | Result |\n| --- | --- |\n| Model transport | local SSE |\n| Session | real SDK |');
      }
      log({ type: 'provider.response-finished', id, scenario });
    }
  });
  // Destroy open streams during shutdown, including long stop/recovery streams.
  server.once('close', () => { for (const response of active) response.destroy(); });
  return server;
}

async function main(): Promise<void> {
  const options = parseArgs();
  await directoryWithoutSymlink(cache);
  const root = options.root ?? await fs.mkdtemp(path.join(cache, 'bot-browser-'));
  if (!within(cache, root)) throw new Error('Fixture root must be under this repository node_modules/.cache');
  await directoryWithoutSymlink(root);
  const files = new FixtureFiles(root);
  // A legitimate marker grants no trust to restored config/log/DB leaves.
  // Inspect the whole disposable tree before reading the marker or importing SDK.
  await files.assertTree();
  const markerPath = path.join(root, '.browser-fixture.json');
  const home = options.home ?? path.join(root, 'home');
  const workspace = options.workspace ?? path.join(root, 'workspace');
  const artifacts = path.join(root, 'artifacts');
  for (const directory of [home, workspace]) {
    if (path.dirname(directory) !== root || directory === artifacts || path.basename(directory).startsWith('.')) {
      throw new Error('Home/workspace must be distinct, non-hidden direct children of fixture root, not artifacts');
    }
  }
  if (home === workspace) throw new Error('Home and workspace must differ');
  let marker: { kind: string; home: string; workspace: string };
  try {
    const markerFile = await files.open(markerPath, constants.O_RDONLY);
    try { marker = JSON.parse(await markerFile.readFile('utf8')) as typeof marker; }
    finally { await markerFile.close(); }
    if (marker.kind !== MARKER || marker.home !== home || marker.workspace !== workspace) throw new Error('Fixture root marker/path mismatch');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if ((await fs.readdir(root)).length > 0) throw new Error('Refusing existing unmarked nonempty fixture root', { cause: error });
    marker = { kind: MARKER, home, workspace };
    await files.write(markerPath, JSON.stringify(marker), true);
  }
  for (const directory of [home, workspace, artifacts]) await directoryWithoutSymlink(directory);
  // One live owner per persisted home; an OS socket is released even on SIGKILL.
  const { createServer: createSocketServer } = await import('node:net');
  const lockPath = path.join(root, 'fixture.sock');
  const lock = createSocketServer();
  try {
    await new Promise<void>((resolve, reject) => {
      lock.once('error', reject);
      lock.listen(lockPath, () => { lock.off('error', reject); resolve(); });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    // A crash leaves the pathname, but not an accepting listener.
    const { createConnection } = await import('node:net');
    const inUse = await new Promise<boolean>((resolve) => {
      const socket = createConnection(lockPath);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { resolve(false); });
    });
    if (inUse) throw new Error('Fixture root already has a running server', { cause: error });
    await fs.unlink(lockPath);
    await new Promise<void>((resolve, reject) => {
      lock.once('error', reject);
      lock.listen(lockPath, () => { lock.off('error', reject); resolve(); });
    });
  }
  const logFile = await files.open(path.join(artifacts, 'fixture.jsonl'), constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND);
  const log = (event: unknown) => {
    const line = `${JSON.stringify({ at: new Date().toISOString(), event })}\n`;
    process.stdout.write(line);
    void logFile.appendFile(line);
  };
  // Must precede all runtime imports: no credentials, plugins, config or databases
  // may resolve against the developer's HOME or inherited provider variables.
  for (const key of Object.keys(process.env)) {
    if (/API_KEY|TOKEN|SECRET|PASSWORD|PROXY|^(SCREAM|OPENAI|ANTHROPIC|GEMINI|GOOGLE|AZURE|AWS|XDG)_/i.test(key)) delete process.env[key];
  }
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  process.env['SCREAM_CODE_HOME'] = home;
  process.env['XDG_CONFIG_HOME'] = path.join(home, '.config');
  process.env['XDG_DATA_HOME'] = path.join(home, '.local', 'share');
  process.env['XDG_CACHE_HOME'] = path.join(home, '.cache');
  process.env['TMPDIR'] = path.join(home, 'tmp');
  await directoryWithoutSymlink(process.env['TMPDIR']);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      return Promise.reject(new Error(`Fixture forbids non-loopback fetch: ${url.origin}`));
    }
    return originalFetch(input, init);
  };
  process.chdir(workspace);
  const provider = createProvider(workspace, log);
  let closeGateway: (() => Promise<void>) | undefined;
  let closing = false;
  const shutdown = async (reason: string) => {
    if (closing) return;
    closing = true;
    log({ type: 'shutdown', reason, keepState: options.keepState });
    let failed = reason === 'startup.error';
    try { await closeGateway?.(); } catch (error) { failed = true; log({ type: 'gateway.close-error', message: String(error) }); }
    try { await closeServer(provider); } catch (error) { failed = true; log({ type: 'provider.close-error', message: String(error) }); }
    await new Promise<void>((resolve) => lock.close(() => { resolve(); }));
    if (!options.keepState && !failed) {
      // Preserve core logs outside the disposable home before removing test data.
      await fs.cp(path.join(home, 'logs'), path.join(artifacts, `runtime-logs-${Date.now()}`), { recursive: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      process.chdir(repo);
      await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    }
    await logFile.close();
    process.exit(failed ? 1 : 0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  try {
    const providerPort = await listen(provider, options.providerPort);
    const configPath = path.join(home, 'config.toml');
    // The provider requires a nonempty key even over loopback; this is synthetic,
    // not a credential, and the local endpoint neither checks nor records it.
    await files.write(configPath, `[providers.local]\ntype = "scream"\nbase_url = "http://127.0.0.1:${providerPort}/v1"\napi_key = ${JSON.stringify('local-fixture-not-a-credential')}\n\n[models.browser-test]\nprovider = "local"\nmodel = "${MODEL}"\nmax_context_size = 100000\n`);
    const uiDir = path.join(repo, 'apps', 'scream-code', 'dist', 'bot-ui');
    await fs.access(path.join(uiDir, 'index.html'));
    // Production startBotServer does not take an explicit workspace/uiDir/identity.
    // Compose the same real public factory instead; do not alter production APIs.
    const [{ ScreamHarness }, { BotRuntime, createHarnessSessionFactory }, { BotStore }, { SseHub }, { createGateway }, { serve }] = await Promise.all([
      import('@scream-code/scream-code-sdk'),
      import('../../../src/bot/server/runtime'),
      import('../../../src/bot/server/store'),
      import('../../../src/bot/server/sse'),
      import('../../../src/bot/server/gateway'),
      import('@hono/node-server'),
    ]);
    const store = new BotStore(path.join(home, 'bot', 'bot.db'));
    store.open();
    const hub = new SseHub();
    let runtime: InstanceType<typeof BotRuntime> | undefined;
    const harness = new ScreamHarness({ homeDir: home, configPath, identity: { userAgentProduct: 'scream-code-cli', version: '0.0.0-test' }, uiMode: 'bot', skillDirs: [], onToolCall: (request) => {
      if (runtime === undefined) throw new Error('Fixture runtime not started');
      return runtime.handleToolCall(request);
    } });
    let gateway: ReturnType<typeof serve> | undefined;
    closeGateway = async () => {
      const errors: unknown[] = [];
      const closers: Array<() => Promise<void>> = [
        async () => { await runtime?.close(); },
        async () => { hub.close(); },
        async () => { if (gateway !== undefined) await closeServer(gateway as Server); },
        async () => { await harness.close(); },
        async () => { store.close(); },
      ];
      for (const close of closers) {
        try { await close(); } catch (error) { errors.push(error); }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Fixture gateway shutdown failed');
    };
    const fixtureTools = ['Read', 'Write', 'AskUserQuestion', 'message_bot'];
    if (store.countBots() === 0) {
      for (const [name, title] of [['Scream', '主会话'], ['Peer', '协作会话']] as const) {
        const bot = store.createBot({ name, title, workspace, model: MODEL, permission: 'bot', rolePrompt: `You are ${name}. This is an isolated local acceptance workspace. Your peer is ${name === 'Peer' ? 'Scream' : 'Peer'}.`, toolPolicy: { allow: fixtureTools, handoff: true } });
        store.createThread(bot.id);
      }
      await files.write(path.join(workspace, 'README.md'), '# Browser acceptance workspace\n\nOnly disposable test data lives here.\n');
      await files.write(path.join(workspace, 'notes', 'sample.md'), '# Nested fixture file\n\nA deterministic Files navigation target.\n');
      await files.write(path.join(workspace, 'large.txt'), 'A deliberately long fixture line for truncation inspection.\n'.repeat(5000));
    }
    // Upgrade roots created by an earlier fixture version, without resetting
    // model/permission/workspace edits made during a browser settings journey.
    for (const bot of store.listBots()) {
      if (['Scream', 'Peer'].includes(bot.name) && !bot.toolPolicy.allow?.includes('message_bot')) {
        store.updateBot(bot.id, { toolPolicy: { ...bot.toolPolicy, allow: fixtureTools } });
      }
    }
    const sessions = createHarnessSessionFactory(harness, { model: MODEL, permission: 'bot' });
    runtime = new BotRuntime({ store, hub, sessions: { async open(bot, thread) {
      const session = await sessions.open(bot, thread);
      const sdkSession = harness.sessions.get(session.id);
      if (sdkSession === undefined) throw new Error('Real SDK session missing');
      // A resumed session can carry the older persisted tool profile.
      await sdkSession.setActiveTools(bot.toolPolicy.allow ?? fixtureTools);
      return session;
    } } });
    runtime.start();
    const app = createGateway({ store, hub, runtime, uiDir, auth: { lan: false, token: undefined } });
    gateway = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: options.port });
    await new Promise<void>((resolve, reject) => {
      gateway.once('listening', resolve);
      gateway.once('error', reject);
    });
    const address = gateway.address();
    if (address === null || typeof address === 'string') throw new Error('Gateway did not bind');
    log({ type: 'ready', url: `http://127.0.0.1:${address.port}`, providerUrl: `http://127.0.0.1:${providerPort}/v1`, root, home, workspace, artifacts, uiDir, pid: process.pid, keepState: options.keepState, bots: store.listBots().map((bot) => ({ id: bot.id, name: bot.name, threadId: store.listThreads(bot.id)[0]?.id })), prompts: ['stream', 'slow-a', 'slow-b', 'stop', 'ask', 'ask-multi', 'file', 'tool-failure', 'provider-error', 'handoff'].map((scenario) => `[[browser:${scenario}]]`) });
  } catch (error) {
    log({ type: 'startup.error', message: error instanceof Error ? error.stack : String(error) });
    await shutdown('startup.error');
  }
}

await main();

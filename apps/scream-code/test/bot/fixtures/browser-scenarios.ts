/** Real gateway journeys. No store imports or DB writes. Run with the same tsx/raw-loader flags as browser-server.ts.
 * --suite basic (default): streaming, FIFO, Ask single/multi/free text, Write/Read, failures, stop.
 * --suite recovery: restart the SAME isolated home, preserving transcript IDs and interrupting an uncertain Run.
 * --suite handoff: real message_bot + independent peer + durable relay (run only after backend contract is ready).
 * --url http://127.0.0.1:3219: exercise an already-running browser fixture without owning/stopping it.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { FixtureFiles, directoryWithoutSymlink } from './browser-isolation';
import type { Bot, Thread, Run, Question, TranscriptSnapshot, ServerEvent, Handoff } from '../../../src/bot/shared/contracts';

const repo = path.resolve(import.meta.dirname, '../../../../..');
const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const suite = value('--suite') ?? 'basic';
assert.ok(['basic', 'recovery', 'handoff'].includes(suite), 'Unknown suite');
let url = value('--url') ?? '';
if (url !== '') assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/, 'Only the loopback fixture is allowed');
const owns = url === '';
if (suite === 'recovery') assert.ok(owns, 'Recovery must own its child fixture');
let child: ChildProcess | undefined;
let childOutput = '';
let root = '';
const evidence: unknown[] = [];
const report = (event: unknown) => { evidence.push(event); process.stdout.write(`${JSON.stringify(event)}\n`); };

async function api<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${url}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const data: unknown = await response.json();
  assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(data)}`);
  return data as T;
}
function curl<T>(route: string): T {
  const command = ['--noproxy', '*', '--fail', '--silent', '--show-error', '--max-time', '15', `${url}${route}`];
  const output = execFileSync('curl', command, { encoding: 'utf8' });
  report({ command: `curl ${command.map((part) => JSON.stringify(part)).join(' ')}`, output: JSON.parse(output) as unknown });
  return JSON.parse(output) as T;
}
async function until<T>(label: string, poll: () => Promise<T | undefined>, timeout = 45_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await poll();
    if (result !== undefined) return result;
    await delay(120);
  }
  throw new Error(`Timed out: ${label}`);
}
async function launch(keep: boolean): Promise<void> {
  childOutput = '';
  child = spawn(process.execPath, ['--import', 'tsx', '--import', './build/register-raw-text-loader.mjs', 'apps/scream-code/test/bot/fixtures/browser-server.ts', '--port', '0', '--root', root, ...(keep ? ['--keep-state'] : [])], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (chunk: Buffer) => { childOutput += chunk.toString(); });
  child.stderr!.on('data', (chunk: Buffer) => { childOutput += chunk.toString(); });
  const ready = await until('fixture ready', async () => {
    if (child!.exitCode !== null) throw new Error(`Fixture exited ${child!.exitCode}: ${childOutput}`);
    for (const line of childOutput.split('\n')) {
      try {
        const parsed = JSON.parse(line) as { event?: { type: string; url: string; providerUrl: string; pid: number } };
        if (parsed.event?.type === 'ready') return parsed.event;
      } catch { /* Non-JSON runtime diagnostic. */ }
    }
    return undefined;
  }, 30_000);
  url = ready.url;
  const { type: _readyType, ...event } = ready;
  report({ type: 'launch', ...event, root, keep });
}
async function stop(): Promise<void> {
  const active = child;
  if (active === undefined) return;
  const exited = active.exitCode === null && active.signalCode === null ? once(active, 'exit') : Promise.resolve([active.exitCode, active.signalCode]);
  if (active.exitCode === null && active.signalCode === null) active.kill('SIGTERM');
  const timeout = setTimeout(() => active.kill('SIGKILL'), 20_000);
  try {
    const outcome = await exited;
    report({ type: 'closed', pid: active.pid, outcome });
    assert.equal(outcome[0], 0, `Fixture did not close cleanly: ${childOutput.slice(-5000)}`);
  } finally { clearTimeout(timeout); child = undefined; }
}
const snapshot = (threadId: string) => api<TranscriptSnapshot>(`/api/threads/${threadId}/messages`);
const getRun = (id: string) => api<Run>(`/api/runs/${id}`);
const terminal = (run: Run) => ['done', 'failed', 'cancelled', 'interrupted'].includes(run.status);
async function finish(id: string, expected = 'done'): Promise<Run> {
  const run = await until(`run ${id} terminal`, async () => { const row = await getRun(id); return terminal(row) ? row : undefined; });
  assert.equal(run.status, expected, JSON.stringify(run));
  return run;
}
async function newThread(bot: Bot, name: string) { return api<Thread>(`/api/bots/${bot.id}/threads`, { title: `Acceptance ${name}` }); }
async function prompt(thread: Thread, scenario: string) { return api<{ runId: string }>(`/api/threads/${thread.id}/messages`, { text: `[[browser:${scenario}]]`, requestKey: `browser-${scenario}-${Date.now()}` }); }
function toolCalls(transcript: TranscriptSnapshot) { return transcript.messages.flatMap((message) => message.toolCalls ?? []); }

async function streaming(bot: Bot): Promise<{ thread: Thread; transcript: TranscriptSnapshot }> {
  const thread = await newThread(bot, 'stream');
  const events: ServerEvent[] = [];
  const controller = new AbortController();
  const response = await fetch(`${url}/api/events`, { signal: controller.signal });
  assert.ok(response.ok && response.body, 'SSE connection');
  const reader = response.body.getReader();
  const read = (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
          if (data !== '') { const event = JSON.parse(data) as ServerEvent; if (event.threadId === thread.id) events.push(event); }
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
  })();
  const growth = new Set<number>();
  try {
    const { runId } = await prompt(thread, 'stream');
    await until('stream terminal', async () => {
      const transcript = await snapshot(thread.id);
      const text = transcript.messages.filter((message) => message.role === 'assistant').map((message) => message.content).join('');
      if (text !== '') growth.add(text.length);
      const run = await getRun(runId);
      if (!terminal(run)) return undefined;
      assert.equal(run.status, 'done', JSON.stringify(run));
      return run;
    });
    const transcript = curl<TranscriptSnapshot>(`/api/threads/${thread.id}/messages`);
    curl<Run>(`/api/runs/${runId}`);
    assert.match(transcript.messages.map((message) => message.content).join('\n'), /Live browser stream completed/);
    assert.ok(growth.size >= 3, `Only ${growth.size} incremental snapshots`);
    const deltas = events.filter((event) => event.type === 'assistant.delta');
    assert.ok(deltas.length >= 3, `Only ${deltas.length} SSE deltas`);
    assert.equal(new Set(transcript.messages.map((message) => message.id)).size, transcript.messages.length);
    assert.ok(transcript.messages.some((message) => message.role === 'assistant' && message.coreSessionId !== undefined && message.coreMessageId !== undefined));
    report({ type: 'PASS', scenario: 'stream', runId, deltas: deltas.length, growingSnapshots: growth.size });
    return { thread, transcript };
  } finally { controller.abort(); await read; }
}
async function basic(bot: Bot): Promise<void> {
  await streaming(bot);
  const fifo = await newThread(bot, 'FIFO');
  const a = await prompt(fifo, 'slow-a');
  await until('first FIFO run starts', async () => (await getRun(a.runId)).status === 'running' ? true : undefined);
  const b = await prompt(fifo, 'slow-b');
  assert.equal((await getRun(b.runId)).status, 'queued');
  const ar = await finish(a.runId); const br = await finish(b.runId);
  assert.ok(ar.endedAt !== null && br.dispatchStartedAt !== null && br.dispatchStartedAt !== undefined && br.dispatchStartedAt >= ar.endedAt, `FIFO overlapped: ${JSON.stringify([ar, br])}`);
  const ft = await snapshot(fifo.id);
  assert.match(ft.messages.filter((message) => message.runId === a.runId && message.role === 'assistant').map((message) => message.content).join(''), /slow-a completed/);
  assert.match(ft.messages.filter((message) => message.runId === b.runId && message.role === 'assistant').map((message) => message.content).join(''), /slow-b completed/);
  report({ type: 'PASS', scenario: 'FIFO', runs: [ar, br] });
  for (const [scenario, answer] of [['ask', 'Alpha'], ['ask-multi', ['Alpha', 'Beta']], ['ask', 'Custom acceptance free text']] as const) {
    const thread = await newThread(bot, typeof answer === 'string' ? answer : 'multi');
    const { runId } = await prompt(thread, scenario);
    const question = await until('real AskUserQuestion callback', async () => {
      const inbox = await api<{ questions: Question[] }>('/api/inbox');
      return inbox.questions.find((entry) => entry.runId === runId);
    });
    assert.equal((await getRun(runId)).status, 'waiting_user');
    assert.equal(question.items[0]?.multiple, scenario === 'ask-multi');
    assert.equal(question.items[0]?.options[0]?.label, 'Alpha');
    const answered = await api<Question>(`/api/questions/${question.id}`, { answers: { [question.items[0]!.id]: answer } });
    assert.equal(answered.status, 'answered');
    await finish(runId);
    const transcript = curl<TranscriptSnapshot>(`/api/threads/${thread.id}/messages`);
    curl<Run>(`/api/runs/${runId}`);
    const ask = toolCalls(transcript).find((call) => call.name === 'AskUserQuestion');
    assert.equal(ask?.status, 'done', JSON.stringify(ask));
    assert.match(JSON.stringify(transcript), /real tool response received/);
    for (const selected of typeof answer === 'string' ? [answer] : answer) assert.ok(JSON.stringify(transcript).includes(selected), `Answer missing: ${selected}`);
    report({ type: 'PASS', scenario, answer, runId, tool: ask });
  }
  for (const scenario of ['file', 'tool-failure', 'provider-error', 'stop']) {
    const thread = await newThread(bot, scenario); const { runId } = await prompt(thread, scenario);
    if (scenario === 'stop') {
      await until('stop stream partial text', async () => (await snapshot(thread.id)).messages.some((message) => /stop piece/.test(message.content)) ? true : undefined);
      await api(`/api/threads/${thread.id}/interrupt`, {});
    }
    const run = await finish(runId, scenario === 'provider-error' ? 'failed' : scenario === 'stop' ? 'cancelled' : 'done');
    const transcript = await snapshot(thread.id);
    if (scenario === 'file') {
      const tools = toolCalls(transcript);
      assert.deepEqual(tools.filter((call) => ['Write', 'Read'].includes(call.name)).map((call) => [call.name, call.status]), [['Write', 'done'], ['Read', 'done']]);
      assert.match(tools.find((call) => call.name === 'Read')?.output ?? '', /written by the real Write tool/);
    }
    if (scenario === 'tool-failure') assert.equal(toolCalls(transcript).find((call) => call.name === 'Read')?.status, 'error');
    if (scenario === 'provider-error') assert.match(run.error ?? '', /Controlled browser acceptance provider failure/);
    if (scenario === 'stop') assert.ok(!transcript.messages.some((message) => message.content.includes('stop completed')));
    report({ type: 'PASS', scenario, run, tools: toolCalls(transcript) });
  }
}
async function recovery(bot: Bot): Promise<void> {
  const before = await streaming(bot);
  const thread = await newThread(bot, 'recovery uncertain stop');
  const { runId } = await prompt(thread, 'stop');
  await until('uncertain Run started', async () => (await snapshot(thread.id)).messages.some((message) => /stop piece/.test(message.content)) ? true : undefined);
  await stop();
  await launch(false);
  curl('/api/health');
  const after = await snapshot(before.thread.id);
  assert.deepEqual(after.messages.map((message) => [message.id, message.content, message.coreSessionId, message.coreMessageId]), before.transcript.messages.map((message) => [message.id, message.content, message.coreSessionId, message.coreMessageId]));
  const interrupted = curl<Run>(`/api/runs/${runId}`);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.recoveryDecision, null);
  report({ type: 'PASS', scenario: 'same-home recovery', interrupted, stableIds: after.messages.map((message) => message.id) });
}
async function handoff(bot: Bot): Promise<void> {
  const thread = await newThread(bot, 'durable handoff'); const { runId } = await prompt(thread, 'handoff');
  await finish(runId);
  const result = await until('handoff delivered with durable relay', async () => {
    const entries = await api<Handoff[]>(`/api/handoffs?threadId=${thread.id}`);
    const entry = entries[0];
    if (entry?.status === 'failed' || entry?.status === 'refused') throw new Error(JSON.stringify(entry));
    return entry?.status === 'delivered' && entry.relayStatus === 'delivered' ? entry : undefined;
  });
  assert.ok(result.toThreadId !== null && result.toThreadId !== thread.id);
  assert.ok(result.targetRunId && result.relayRunId);
  await finish(result.targetRunId); await finish(result.relayRunId);
  const peer = await snapshot(result.toThreadId);
  assert.match(peer.messages.filter((message) => message.role === 'assistant').map((message) => message.content).join(''), /Peer result: acceptance handoff executed/);
  const source = await snapshot(thread.id);
  assert.equal(toolCalls(source).find((call) => call.name === 'message_bot')?.status, 'done');
  assert.ok(source.messages.some((message) => message.runId === result.relayRunId && message.role === 'assistant' && /Peer result/.test(message.content)), JSON.stringify({ relayRunId: result.relayRunId, messages: source.messages.map((message) => ({ runId: message.runId, role: message.role, content: message.content.slice(0, 120) })) }, null, 2));
  report({ type: 'PASS', scenario: 'handoff real engine and durable relay', result });
}

let failure: unknown;
try {
  if (owns) {
    const cache = path.join(repo, 'node_modules', '.cache'); await directoryWithoutSymlink(cache);
    root = await fs.mkdtemp(path.join(cache, `bot-browser-${suite}-`));
    await launch(suite === 'recovery');
  }
  assert.deepEqual(curl('/api/health'), { ok: true });
  const bot = (await api<Bot[]>('/api/bots')).find((entry) => entry.name === 'Scream');
  assert.ok(bot, 'Seeded Scream Bot');
  if (suite === 'basic') await basic(bot);
  if (suite === 'recovery') await recovery(bot);
  if (suite === 'handoff') await handoff(bot);
} catch (error) { failure = error; report({ type: 'FAIL', suite, error: error instanceof Error ? error.stack : String(error), childTail: childOutput.slice(-9000) }); }
finally {
  if (owns) {
    try { await stop(); } catch (error) { failure ??= error; report({ type: 'cleanup-failure', error: String(error) }); }
    if (root !== '') {
      const files = new FixtureFiles(root);
      await files.write(path.join(root, 'artifacts', `scenario-${suite}.json`), JSON.stringify(evidence, null, 2));
      report({ type: 'artifacts', path: path.join(root, 'artifacts'), homeExists: await fs.lstat(path.join(root, 'home')).then(() => true, () => false), workspaceExists: await fs.lstat(path.join(root, 'workspace')).then(() => true, () => false) });
    }
  }
}
if (failure !== undefined) process.exitCode = 1;

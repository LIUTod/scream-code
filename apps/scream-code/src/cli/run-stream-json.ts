/**
 * Claude Code stream-json I/O adapter.
 *
 * Reads stdin in Claude Code stream-json dialect, processes messages through
 * the ScreamCode agent, and writes stdout in Claude Code dialect.  This lets
 * cc-connect (and any tool that speaks the Claude Code stdio protocol) use
 * ScreamCode as a drop-in agent backend.
 *
 * Protocol reference:
 *   https://docs.anthropic.com/en/docs/claude-code/stdio-stream-json
 */

import { createInterface } from "node:readline";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ScreamHarness,
  log,
  type Session,
  type TelemetryClient,
} from "@scream-cli/scream-code-sdk";
import { track } from "@scream-cli/scream-telemetry";

import { createCliTelemetryBootstrap } from "./telemetry";
import { createScreamCodeHostIdentity } from "./version";

// ─── Types ────────────────────────────────────────────────────────────────

interface StdinUserMessage {
  type: "user";
  message: {
    role: "user";
    content: string | StdinContentBlock[];
  };
}

interface StdinControlResponse {
  type: "control_response";
  response: {
    subtype: "success";
    request_id: string;
    response: {
      behavior: "allow" | "deny";
      message?: string;
      updatedInput?: Record<string, unknown>;
    };
  };
}

type StdinMessage = StdinUserMessage | StdinControlResponse;

interface StdinContentBlock {
  type: "text" | "image";
  text?: string;
  source?: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

interface ClaudeSystemEvent {
  type: "system";
  subtype: "init";
  session_id: string;
}

interface ClaudeContentText {
  type: "text";
  text: string;
}

interface ClaudeContentThinking {
  type: "thinking";
  thinking: string;
}

interface ClaudeContentToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface ClaudeContentToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

type ClaudeContentBlock =
  | ClaudeContentText
  | ClaudeContentThinking
  | ClaudeContentToolUse
  | ClaudeContentToolResult;

interface ClaudeAssistantEvent {
  type: "assistant";
  message: {
    id: string;
    role: "assistant";
    model: string;
    content: ClaudeContentBlock[];
  };
  session_id: string;
}

interface ClaudeUserEvent {
  type: "user";
  message: {
    role: "user";
    content: ClaudeContentBlock[];
  };
  session_id: string;
}

interface ClaudeResultEvent {
  type: "result";
  subtype: "success" | "error";
  result: string;
  session_id: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

type ClaudeEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent;

interface StreamJsonOptions {
  resume?: string;
  model?: string;
  permissionMode?: string;
  workDir?: string;
  skillsDirs: string[];
  appendSystemPrompt?: string;
}

interface TokenUsage {
  input: number;
  output: number;
}

// ─── Writer ───────────────────────────────────────────────────────────────

class ClaudeStreamJsonWriter {
  private sessionId = "";
  private msgCounter = 0;
  private pendingText = "";
  private pendingThinking = "";
  private pendingToolCalls: ClaudeContentToolUse[] = [];
  private currentModel = "";
  private tokenUsage: TokenUsage = { input: 0, output: 0 };

  constructor(private readonly writeLine: (line: string) => void) {}

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  setModel(model: string): void {
    this.currentModel = model;
  }

  /** Emit the `system` / `init` event.  Called once after session creation. */
  emitSystem(sessionId: string): void {
    this.sessionId = sessionId;
    this.writeJson({ type: "system", subtype: "init", session_id: sessionId });
  }

  /** Accumulate assistant text delta.  Flush buffered thinking first. */
  writeAssistantDelta(delta: string): void {
    this.flushThinking();
    this.pendingText += delta;
  }

  /** Buffer thinking delta.  Flushed lazily when text/tool/result arrives. */
  writeThinkingDelta(delta: string): void {
    this.pendingThinking += delta;
  }

  private flushThinking(): void {
    if (this.pendingThinking.length === 0) return;
    this.writeAssistantEvent([{ type: "thinking", thinking: this.pendingThinking }]);
    this.pendingThinking = "";
  }

  /** Record a tool call start.  Flush buffered thinking first. */
  writeToolCall(toolCallId: string, name: string, args: unknown): void {
    this.flushThinking();
    const tc: ClaudeContentToolUse = {
      type: "tool_use",
      id: toolCallId,
      name,
      input: args,
    };
    // Replace if already exists (delta accumulated), otherwise push
    const idx = this.pendingToolCalls.findIndex((t) => t.id === toolCallId);
    if (idx >= 0) {
      this.pendingToolCalls[idx] = tc;
    } else {
      this.pendingToolCalls.push(tc);
    }
  }

  /** Record a tool call delta. */
  writeToolCallDelta(
    toolCallId: string,
    name: string | undefined,
    argumentsPart: string | undefined,
  ): void {
    const existing = this.pendingToolCalls.find((t) => t.id === toolCallId);
    if (existing) {
      if (name !== undefined) existing.name = name;
      if (argumentsPart !== undefined) {
        // Merge argumentsPart into the input string
        const current = typeof existing.input === "string" ? existing.input : "";
        existing.input = current + argumentsPart;
      }
    } else {
      this.pendingToolCalls.push({
        type: "tool_use",
        id: toolCallId,
        name: name ?? "",
        input: argumentsPart ?? "",
      });
    }
  }

  /** Write a tool result. Flush any pending assistant content first. */
  writeToolResult(toolCallId: string, output: unknown, isError?: boolean): void {
    this.flushAssistant();
    this.writeJson({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            content: typeof output === "string" ? output : JSON.stringify(output),
            is_error: isError ?? false,
          },
        ],
      },
      session_id: this.sessionId,
    });
  }

  /** Flush accumulated assistant text and tool calls as one event. */
  flushAssistant(): void {
    this.flushThinking();
    const blocks: ClaudeContentBlock[] = [];
    if (this.pendingText.length > 0) {
      blocks.push({ type: "text", text: this.pendingText });
    }
    for (const tc of this.pendingToolCalls) {
      blocks.push(tc);
    }
    if (blocks.length > 0) {
      this.writeAssistantEvent(blocks);
    }
    this.pendingText = "";
    this.pendingToolCalls = [];
  }

  /** Discard accumulated assistant content without writing (used on retry). */
  discardAssistant(): void {
    this.pendingText = "";
    this.pendingThinking = "";
    this.pendingToolCalls = [];
  }

  /** Emit the `result` event marking end of turn. */
  emitResult(
    subtype: "success" | "error",
    summary: string,
    usage?: TokenUsage,
  ): void {
    this.flushThinking();
    this.flushAssistant();
    const event: ClaudeResultEvent = {
      type: "result",
      subtype,
      result: summary,
      session_id: this.sessionId,
    };
    if (usage && (usage.input > 0 || usage.output > 0)) {
      event.usage = {
        input_tokens: usage.input,
        output_tokens: usage.output,
      };
    }
    this.writeJson(event);
    this.tokenUsage = { input: 0, output: 0 };
  }

  /** Emit a resume hint as a meta message (same format as Claude Code). */
  emitResumeHint(sessionId: string): void {
    this.writeJson({
      role: "meta",
      type: "session.resume_hint",
      session_id: sessionId,
      command: `scream -r ${sessionId}`,
      content: `Resume this session: scream -r ${sessionId}`,
    });
  }

  updateUsage(input: number, output: number): void {
    if (input > 0) this.tokenUsage.input += input;
    if (output > 0) this.tokenUsage.output += output;
  }

  private nextMsgId(): string {
    this.msgCounter += 1;
    return `msg_${this.msgCounter.toString(36)}`;
  }

  private writeAssistantEvent(blocks: ClaudeContentBlock[]): void {
    this.writeJson({
      type: "assistant",
      message: {
        id: this.nextMsgId(),
        role: "assistant",
        model: this.currentModel || "unknown",
        content: blocks,
      },
      session_id: this.sessionId,
    });
  }

  private writeJson(event: ClaudeEvent | Record<string, unknown>): void {
    this.writeLine(JSON.stringify(event));
  }
}

// ─── stdin reader ─────────────────────────────────────────────────────────

async function* readStdinMessages(): AsyncGenerator<StdinMessage> {
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: StdinMessage;
    try {
      msg = JSON.parse(trimmed) as StdinMessage;
    } catch {
      log.warn("stream-json: failed to parse stdin line", { line: trimmed.slice(0, 200) });
      continue;
    }

    if (msg.type === "user" || msg.type === "control_response") {
      yield msg;
    } else {
      log.debug("stream-json: ignoring unknown stdin message type", {
        type: (msg as { type?: string }).type,
      });
    }
  }
}

/** Extract plain text from a Claude Code-style user message. */
function extractUserText(msg: StdinUserMessage): string {
  const content = msg.message.content;
  if (typeof content === "string") return content;
  // Multimodal: extract text parts only
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

// ─── main ─────────────────────────────────────────────────────────────────

export async function runStreamJson(opts: StreamJsonOptions): Promise<void> {
  const _startedAt = Date.now();
  const workDir = opts.workDir ?? process.cwd();
  const telemetryBootstrap = createCliTelemetryBootstrap();
  const telemetryClient: TelemetryClient = { track };

  const harness = new ScreamHarness({
    homeDir: telemetryBootstrap.homeDir,
    identity: createScreamCodeHostIdentity("dev"),
    uiMode: "print",
    skillDirs: opts.skillsDirs,
    telemetry: telemetryClient,
  });

  const writer = new ClaudeStreamJsonWriter((line) => {
    process.stdout.write(`${line}\n`);
  });

  let session: Session | undefined;
  let currentSessionId: string | undefined;

  // cc-connect passes --append-system-prompt with instructions for
  // cc-connect send --image / --file etc.  Inject them into the agent's
  // system prompt via the project-level AGENTS.md so the agent knows how
  // to deliver generated files back to the chat user.
  const agentsMdPath = join(workDir, ".scream-code", "AGENTS.md");
  let originalAgentsMd: string | undefined;
  let injectedAgentsMd = false;
  if (opts.appendSystemPrompt) {
    try { originalAgentsMd = await readFile(agentsMdPath, "utf-8"); } catch { /* new file */ }
    await mkdir(join(workDir, ".scream-code"), { recursive: true });
    const merged = originalAgentsMd
      ? `${opts.appendSystemPrompt}\n\n${originalAgentsMd}`
      : opts.appendSystemPrompt;
    await writeFile(agentsMdPath, merged, "utf-8");
    injectedAgentsMd = true;
    log.info("stream-json: injected cc-connect system prompt into AGENTS.md");
  }

  try {
    await harness.ensureConfigFile();
    const config = await harness.getConfig();

    // ── Read stdin messages in a loop ──────────────────────────────────
    for await (const msg of readStdinMessages()) {
      if (msg.type === "control_response") {
        // For now, permissions are auto-approved internally, so
        // control_response is a no-op.  If we later add control_request
        // emission, we'd route the response to the pending request.
        log.debug("stream-json: control_response received (auto-approved mode)", {
          requestId: msg.response.request_id,
          behavior: msg.response.response.behavior,
        });
        continue;
      }

      // msg.type === "user"
      const userText = extractUserText(msg);
      if (!userText) {
        log.warn("stream-json: empty user message, skipping");
        continue;
      }

      // ── Create or reuse session ──────────────────────────────────────
      // One channel = one session.  Always use a fixed key so all
      // messages from this channel accumulate in the same ScreamCode
      // session, regardless of what cc-connect passes as --resume.
      const sessionKey = "cc-connect-main";
      if (!session) {
        // Try to resume an existing session first
        const existing = await harness.listSessions({ sessionId: sessionKey, workDir });
        if (existing.length > 0) {
          try {
            session = await harness.resumeSession({ id: sessionKey });
            log.info("stream-json: resumed session", { sessionId: session.id });
          } catch (err) {
            // The session is in an inconsistent state: either the directory
            // exists without an index entry, or the index has a stale entry
            // pointing to a missing directory.  We need to clean up BOTH
            // before createSession can succeed (it checks index first, then
            // the directory — either will block creation).
            log.warn("stream-json: resume failed, repairing session", {
              sessionKey,
              error: String(err),
            });

            // Route 1: deleteSession — works when index entry and directory
            // both exist (the normal path).
            await harness.deleteSession(sessionKey).catch(() => {});

            // Route 2: if the directory exists but the index entry was
            // already missing, deleteSession won't touch it (it needs the
            // index entry).  Remove it directly.
            const orphanDir = existing[0]?.sessionDir;
            if (orphanDir) {
              await rm(orphanDir, { recursive: true, force: true }).catch(() => {});
            }

            const model = opts.model ?? config.defaultModel;
            session = await harness.createSession({
              id: sessionKey,
              workDir,
              model,
              permission: "auto",
            });
            log.info("stream-json: recreated session", {
              sessionId: session.id,
            });
          }
        } else {
          const model = opts.model ?? config.defaultModel;
          session = await harness.createSession({
            id: sessionKey,
            workDir,
            model,
            permission: "auto",
          });
          log.info("stream-json: created session", { sessionId: session.id });
        }

        currentSessionId = session.id;
        writer.setSessionId(session.id);
        writer.setModel(opts.model ?? config.defaultModel ?? "");
        // Emit the deterministic session key so cc-connect stores it
        // and passes it back via --resume next time.
        writer.emitSystem(sessionKey);

        // Auto-approve all permissions (cc-connect handles its own permission flow)
        session.setApprovalHandler(() => ({ decision: "approved" }));
        session.setQuestionHandler(() => null);
      }

      // ── Wire up events → Claude dialect ─────────────────────────────
      let activeTurnId: number | undefined;
      let activeAgentId: string | undefined;
      let settled = false;
      let unsubscribe: (() => void) | undefined;

      const turnPromise = new Promise<void>((resolve, reject) => {
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          unsubscribe?.();
          if (error) {
            writer.emitResult("error", error.message);
            reject(error);
          } else {
            writer.emitResult("success", "");
            resolve();
          }
        };

        unsubscribe = session!.onEvent((event) => {
          if (event.type === "error") {
            if (event.agentId !== "main") return;
            finish(new Error(`${event.code}: ${event.message}`));
            return;
          }

          if (event.type === "turn.started" && activeTurnId === undefined) {
            if (event.agentId !== "main") return;
            activeTurnId = event.turnId;
            activeAgentId = event.agentId;
            return;
          }

          if (
            activeTurnId === undefined ||
            activeAgentId === undefined ||
            !("turnId" in event) ||
            event.turnId !== activeTurnId ||
            event.agentId !== activeAgentId
          ) {
            return;
          }

          // Translate ScreamCode events to Claude stream-json dialect.
          // We deliberately suppress thinking, tool_call, and tool_result
          // events so chat platforms only see the final text result.
          // cc-connect's TypingIndicator (supported by weixin/feishu/etc.)
          // handles the "thinking..." status independently of these events.
          const type = event.type;
          if (type === "turn.step.started" || type === "turn.step.interrupted") {
            writer.flushAssistant();
          } else if (type === "turn.step.retrying") {
            writer.discardAssistant();
          } else if (type === "assistant.delta") {
            writer.writeAssistantDelta(event.delta);
          } else if (type === "turn.step.completed") {
            if (event.usage) {
              const inputTotal =
                (event.usage.inputOther ?? 0) +
                (event.usage.inputCacheRead ?? 0) +
                (event.usage.inputCacheCreation ?? 0);
              writer.updateUsage(inputTotal, event.usage.output ?? 0);
            }
          } else if (type === "turn.ended") {
            if (event.reason === "completed") {
              finish();
            } else {
              const errMsg =
                event.error !== undefined
                  ? `${event.error.code}: ${event.error.message}`
                  : `Turn ended: ${event.reason}`;
              finish(new Error(errMsg));
            }
          }
          // thinking.delta, tool.call.*, tool.result are intentionally
          // suppressed — the agent uses tools internally but we don't
          // broadcast that to the chat platform.
          // All other event types are silently ignored.
        });

        session!.prompt(userText).catch((error: unknown) => {
          const msg = error instanceof Error ? error.message : String(error);
          // Orphaned tool_calls in session history — recreate the session
          // so the next message starts fresh.
          if (msg.includes("insufficient tool messages") || msg.includes("tool_calls")) {
            log.warn("stream-json: resetting session after tool call mismatch", {
              sessionId: session?.id,
              error: msg,
            });
            // Close and delete in the background, fire-and-forget.
            void session?.close().catch(() => {});
            void harness.deleteSession(sessionKey).catch(() => {});
            session = undefined;
            finish(new Error("会话已自动重置，请重新发送你的消息。"));
            return;
          }
          finish(error instanceof Error ? error : new Error(msg));
        });
      });

      await turnPromise;
    }
  } catch (error) {
    log.error("stream-json: fatal", { error });
    writer.emitResult("error", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    // Emit resume hint so user knows how to continue
    if (currentSessionId) {
      writer.emitResumeHint(currentSessionId);
    }

    try {
      if (session) {
        await session.close();
      }
      await harness.close();
    } catch {
      // Best-effort cleanup
    }

    // Restore AGENTS.md to its original state (undo cc-connect injection)
    if (injectedAgentsMd) {
      try {
        if (originalAgentsMd === undefined) {
          await rm(agentsMdPath, { force: true });
        } else {
          await writeFile(agentsMdPath, originalAgentsMd, "utf-8");
        }
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

/** Install termination handlers so we can clean up on SIGINT / SIGTERM. */
export function installStreamJsonTerminationHandlers(
  cleanup: () => Promise<void>,
): () => void {
  let terminating = false;
  const handler = async (signal: NodeJS.Signals): Promise<void> => {
    if (terminating) return;
    terminating = true;
    try {
      await cleanup();
    } finally {
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
  };
  const onSigint = () => { void handler("SIGINT"); };
  const onSigterm = () => { void handler("SIGTERM"); };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

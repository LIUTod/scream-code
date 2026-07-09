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
  resolveScreamHome,
  type Session,
} from "@scream-code/scream-code-sdk";
import { setLocale } from "@scream-code/config";

import { loadTuiConfig, TuiConfigParseError } from "#/tui/config";
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

interface StdinControlCancel {
  type: "control_cancel_request";
  request_id: string;
}

type StdinMessage = StdinUserMessage | StdinControlResponse | StdinControlCancel;

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

interface ClaudeControlRequestEvent {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: unknown;
  };
}

type ClaudeEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent
  | ClaudeControlRequestEvent;

interface StreamJsonOptions {
  resume?: string;
  model?: string;
  permissionMode?: string;
  workDir?: string;
  skillsDirs: string[];
  appendSystemPrompt?: string;
  appendSystemPromptFile?: string;
  systemPrompt?: string;
  allowedTools?: string;
  disallowedTools?: string;
  effort?: string;
  maxContextTokens?: string;
  pluginDirs: string[];
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
  emitSystem(sessionId: string, model?: string): void {
    this.sessionId = sessionId;
    const event: Record<string, unknown> = { type: "system", subtype: "init", session_id: sessionId };
    if (model) event["model"] = model;
    this.writeLine(JSON.stringify(event));
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

  /** Emit a `control_request` event for cc-connect permission flow.
   *  Format matches cc-connect's handleControlRequest which expects
   *  `request.subtype = "can_use_tool"`, `request.tool_name`, `request.input`. */
  emitControlRequest(requestId: string, toolCallId: string, toolName: string, input: unknown): void {
    this.writeJson({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "can_use_tool", tool_name: toolName, input },
    });
  }

  updateUsage(input: number, output: number): void {
    if (input > 0) this.tokenUsage.input += input;
    if (output > 0) this.tokenUsage.output += output;
  }

  /** Returns the accumulated token usage for the current turn. Used by
   *  the result event emitter so the final `result` event carries the
   *  turn's total token usage. Without this, usage was accumulated but
   *  never emitted — consumers (cc-connect, mobile clients) saw empty
   *  usage fields. */
  getTokenUsage(): TokenUsage {
    return { ...this.tokenUsage };
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

    if (msg.type === "user" || msg.type === "control_response" || msg.type === "control_cancel_request") {
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

// ─── Mode mapping ─────────────────────────────────────────────────────────

import type { PermissionMode } from "@scream-code/scream-code-sdk";

interface MappedMode {
  permission: PermissionMode;
  planMode: boolean;
}

function mapCcConnectMode(mode: string | undefined): MappedMode {
  switch (mode) {
    case "default":
      return { permission: "manual", planMode: false };
    case "acceptEdits":
      return { permission: "manual", planMode: false };
    case "plan":
      return { permission: "manual", planMode: true };
    case "auto":
      return { permission: "auto", planMode: false };
    case "yolo":
    case "bypassPermissions":
      return { permission: "yolo", planMode: false };
    case "dontAsk":
      return { permission: "manual", planMode: false };
    default:
      return { permission: "auto", planMode: false };
  }
}

// ─── main ─────────────────────────────────────────────────────────────────

export async function runStreamJson(opts: StreamJsonOptions): Promise<void> {
  const homeDir = resolveScreamHome();
  const workDir = opts.workDir ?? process.cwd();

  const harness = new ScreamHarness({
    homeDir,
    identity: createScreamCodeHostIdentity("dev"),
    uiMode: "print",
    skillDirs: opts.skillsDirs,
  });

  // Read `[subagentModels]` from tui.toml so `/model diy` bindings configured
  // in the interactive TUI also apply to cc-connect stream-json sessions.
  // Read once at startup; cc-connect is a long-lived process that doesn't
  // watch tui.toml for changes. A malformed tui.toml falls back to empty
  // bindings rather than aborting the protocol handshake.
  let streamTuiConfig;
  try {
    streamTuiConfig = await loadTuiConfig();
    setLocale(streamTuiConfig.language);
  } catch (error) {
    if (!(error instanceof TuiConfigParseError)) throw error;
    streamTuiConfig = error.fallback;
    setLocale(streamTuiConfig.language);
  }
  const streamSubagentModels = streamTuiConfig.subagentModels;
  harness.setSubagentModelBindings(() => streamSubagentModels);

  const writer = new ClaudeStreamJsonWriter((line) => {
    process.stdout.write(`${line}\n`);
  });

  let session: Session | undefined;
  let currentSessionId: string | undefined;
  let sessionKey = "cc-connect-main";

  // Pending approvals awaiting control_response from cc-connect.
  const pendingApprovals = new Map<
    string,
    { resolve: (response: { decision: "approved" | "rejected"; scope?: "session"; feedback?: string }) => void }
  >();

  // Subagent id → name mapping (completed/failed events only carry id).
  const subagentNames = new Map<string, string>();

  // cc-connect passes --system-prompt (replaces default), --append-system-prompt
  // (text), and/or --append-system-prompt-file (path to a file containing the
  // prompt) with instructions for cc-connect send --image / --file etc.
  // Inject them into the agent's system prompt via the project-level AGENTS.md
  // so the agent knows how to deliver generated files back to the chat user.
  const agentsMdPath = join(workDir, ".scream-code", "AGENTS.md");
  let originalAgentsMd: string | undefined;
  let injectedAgentsMd = false;

  // Merge text + file sources. cc-connect may pass either or both; the file
  // variant is newer (Claude Code SDK parity) and typically carries the
  // bulk of platform-specific instructions.
  let appendPrompt = opts.appendSystemPrompt ?? "";
  if (opts.appendSystemPromptFile) {
    try {
      const fileContent = await readFile(opts.appendSystemPromptFile, "utf-8");
      appendPrompt = appendPrompt
        ? `${appendPrompt}\n\n${fileContent}`
        : fileContent;
      log.info("stream-json: loaded append-system-prompt-file", {
        path: opts.appendSystemPromptFile,
        bytes: fileContent.length,
      });
    } catch (error) {
      log.warn("stream-json: failed to read append-system-prompt-file", {
        path: opts.appendSystemPromptFile,
        error: String(error),
      });
    }
  }

  const hasSystemPrompt = opts.systemPrompt && opts.systemPrompt.trim().length > 0;
  if (hasSystemPrompt || appendPrompt) {
    try { originalAgentsMd = await readFile(agentsMdPath, "utf-8"); } catch { /* new file */ }
    await mkdir(join(workDir, ".scream-code"), { recursive: true });
    const sendHint =
      '【重要】你可以通过以下命令向用户发送图片或文件：\n' +
      '  cc-connect send --image /absolute/path/to/image.png\n' +
      '  cc-connect send --file /absolute/path/to/file.pdf\n' +
      '当用户要求你发送文件、截图、生成的图片时，使用 Bash 工具执行上述命令即可。\n';
    // --system-prompt replaces the default; --append-system-prompt appends.
    const systemSection = hasSystemPrompt
      ? `# System Prompt (from --system-prompt)\n\n${opts.systemPrompt}\n`
      : "";
    const appendSection = appendPrompt ? appendPrompt : "";
    const ccPrompt = `${sendHint}\n${systemSection}\n${appendSection}`;
    const merged = originalAgentsMd
      ? `${ccPrompt}\n\n${originalAgentsMd}`
      : ccPrompt;
    await writeFile(agentsMdPath, merged, "utf-8");
    injectedAgentsMd = true;
    log.info("stream-json: injected cc-connect system prompt into AGENTS.md", {
      hasSystemPrompt,
      hasAppendPrompt: appendPrompt.length > 0,
    });
  }

  try {
    await harness.ensureConfigFile();
    const config = await harness.getConfig();

    // ── Read stdin messages in a loop ──────────────────────────────────
    for await (const msg of readStdinMessages()) {
      if (msg.type === "control_response") {
        const pending = pendingApprovals.get(msg.response.request_id);
        if (pending) {
          pendingApprovals.delete(msg.response.request_id);
          const behavior = msg.response.response.behavior;
          pending.resolve({
            decision: behavior === "allow" ? "approved" : "rejected",
            scope: behavior === "allow" ? "session" : undefined,
            feedback: msg.response.response.message,
          });
        } else {
          log.warn("stream-json: control_response for unknown request_id", {
            requestId: msg.response.request_id,
          });
        }
        continue;
      }

      if (msg.type === "control_cancel_request") {
        const pending = pendingApprovals.get(msg.request_id);
        if (pending) {
          pendingApprovals.delete(msg.request_id);
          pending.resolve({
            decision: "rejected",
            feedback: "Permission request cancelled",
          });
        }
        continue;
      }

      // msg.type === "user"
      const userText = extractUserText(msg);
      if (!userText) {
        log.warn("stream-json: empty user message, skipping");
        continue;
      }

      // ── Create or reuse session ──────────────────────────────────────
      // One channel = one session.  Use --resume if cc-connect passes one,
      // otherwise fall back to the deterministic key.
      sessionKey = opts.resume ?? "cc-connect-main";
      const { permission: mappedPermission, planMode: mappedPlanMode } = mapCcConnectMode(
        opts.permissionMode,
      );
      if (!session) {
        // Try to resume an existing session first
        const existing = await harness.listSessions({ sessionId: sessionKey, workDir });
        if (existing.length > 0) {
          try {
            session = await harness.resumeSession({ id: sessionKey });
            log.info("stream-json: resumed session", { sessionId: session.id });
          } catch (error) {
            // The session is in an inconsistent state: either the directory
            // exists without an index entry, or the index has a stale entry
            // pointing to a missing directory.  We need to clean up BOTH
            // before createSession can succeed (it checks index first, then
            // the directory — either will block creation).
            log.warn("stream-json: resume failed, repairing session", {
              sessionKey,
              error: String(error),
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
              permission: mappedPermission,
              planMode: mappedPlanMode,
              thinking: opts.effort,
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
            permission: mappedPermission,
            planMode: mappedPlanMode,
            thinking: opts.effort,
          });
          log.info("stream-json: created session", { sessionId: session.id });
        }

        currentSessionId = session.id;
        writer.setSessionId(session.id);
        writer.setModel(opts.model ?? config.defaultModel ?? "");
        // Emit the deterministic session key so cc-connect stores it
        // and passes it back via --resume next time.
        writer.emitSystem(sessionKey, opts.model ?? config.defaultModel);

        // ── Approval handler wired to cc-connect control_request ─────────
        function sendControlRequest(
          request: { toolCallId: string; toolName: string; action: string; display: unknown },
        ): Promise<{ decision: "approved" | "rejected"; scope?: "session"; feedback?: string }> {
          let resolve!: (value: {
            decision: "approved" | "rejected";
            scope?: "session";
            feedback?: string;
          }) => void;
          const promise = new Promise<{
            decision: "approved" | "rejected";
            scope?: "session";
            feedback?: string;
          }>((res) => {
            resolve = res;
          });
          const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          pendingApprovals.set(reqId, { resolve });
          writer.emitControlRequest(reqId, request.toolCallId, request.toolName, request.display);
          return promise;
        }

        // Build tool whitelist/blacklist from cc-connect flags.
        const allowedSet = opts.allowedTools
          ? new Set(opts.allowedTools.split(",").map((t) => t.trim()).filter(Boolean))
          : undefined;
        const disallowedSet = opts.disallowedTools
          ? new Set(opts.disallowedTools.split(",").map((t) => t.trim()).filter(Boolean))
          : undefined;

        function isToolBlocked(toolName: string): boolean {
          if (disallowedSet?.has(toolName)) return true;
          if (allowedSet && allowedSet.size > 0 && !allowedSet.has(toolName)) return true;
          return false;
        }

        switch (opts.permissionMode) {
          case "yolo":
          case "bypassPermissions":
            session.setApprovalHandler((request) => {
              if (isToolBlocked(request.toolName)) {
                return { decision: "rejected", feedback: `Tool ${request.toolName} is disallowed` };
              }
              return { decision: "approved" };
            });
            break;
          case "dontAsk":
            session.setApprovalHandler((request) => {
              if (disallowedSet?.has(request.toolName)) {
                return { decision: "rejected", feedback: `Tool ${request.toolName} is disallowed` };
              }
              if (allowedSet?.has(request.toolName)) {
                return { decision: "approved" };
              }
              return ({
                decision: "rejected",
                feedback: "dontAsk mode: tool call auto-denied",
              });
            });
            break;
          case "acceptEdits":
            session.setApprovalHandler((request) => {
              if (isToolBlocked(request.toolName)) {
                return { decision: "rejected", feedback: `Tool ${request.toolName} is disallowed` };
              }
              if (["Edit", "Write"].includes(request.toolName)) {
                return { decision: "approved" };
              }
              return sendControlRequest(request);
            });
            break;
          default:
            // default / plan / auto → all route through control_request
            session.setApprovalHandler((request) => {
              if (isToolBlocked(request.toolName)) {
                return { decision: "rejected", feedback: `Tool ${request.toolName} is disallowed` };
              }
              return sendControlRequest(request);
            });
            break;
        }
        session.setQuestionHandler(() => null);
      }
      let resolve: () => void;
      let reject: (error: Error) => void;
      const turnPromise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      let activeTurnId: number | undefined;
      let activeAgentId: string | undefined;
      let settled = false;
      let unsubscribe: (() => void) | undefined;

      const finish = (error?: Error, exitCode?: number): void => {
        if (settled) return;
        settled = true;
        unsubscribe?.();
        if (error) {
          writer.emitResult("error", error.message, writer.getTokenUsage());
          if (exitCode !== undefined) {
            process.exitCode = exitCode;
          }
          reject(error);
        } else {
          writer.emitResult("success", "", writer.getTokenUsage());
          resolve();
        }
      };

      unsubscribe = session.onEvent((event) => {
        if (event.type === "error") {
          if (event.agentId !== "main") return;
          const errCode = event.code;
          let exitCode = 1;
          if (
            errCode === "provider.auth_error" ||
            errCode === "provider.rate_limit" ||
            errCode === "provider.api_error" ||
            errCode === "provider.connection_error"
          ) {
            exitCode = 3;
          }
          finish(new Error(`${event.code}: ${event.message}`), exitCode);
          return;
        }

        // Subagent lifecycle events — show progress in chat
        if (event.type === "subagent.spawned") {
          subagentNames.set(event.subagentId, event.subagentName);
          writer.writeAssistantDelta(`\n[子任务: ${event.subagentName}]\n`);
          return;
        }
        if (event.type === "subagent.completed") {
          const name = subagentNames.get(event.subagentId) ?? event.subagentId;
          writer.writeAssistantDelta(`\n[子任务完成: ${name}]\n`);
          subagentNames.delete(event.subagentId);
          return;
        }
        if (event.type === "subagent.failed") {
          const name = subagentNames.get(event.subagentId) ?? event.subagentId;
          writer.writeAssistantDelta(`\n[子任务失败: ${name} - ${event.error}]\n`);
          subagentNames.delete(event.subagentId);
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
        // Forward thinking, tool_use, and tool_result events so cc-connect
        // can display tool progress in chat platforms (Feishu/Telegram/etc.).
        const type = event.type;
        if (type === "turn.step.started" || type === "turn.step.interrupted") {
          writer.flushAssistant();
        } else if (type === "turn.step.retrying") {
          writer.discardAssistant();
        } else if (type === "assistant.delta") {
          writer.writeAssistantDelta(event.delta);
        } else if (type === "thinking.delta") {
          writer.writeThinkingDelta(event.delta);
        } else if (type === "tool.call.started") {
          writer.writeToolCall(event.toolCallId, event.name, event.args);
        } else if (type === "tool.call.delta") {
          writer.writeToolCallDelta(event.toolCallId, event.name, event.argumentsPart);
        } else if (type === "tool.result") {
          writer.writeToolResult(event.toolCallId, event.output, event.isError);
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
          } else if (event.reason === "cancelled") {
            // SIGINT handler sets exitCode=130; don't override.
            finish(new Error("Turn cancelled"));
          } else {
            // reason === 'failed'
            const errCode = event.error?.code;
            const errMsg =
              event.error !== undefined
                ? `${event.error.code}: ${event.error.message}`
                : `Turn ended: ${event.reason}`;
            // Semantic exit codes:
            //   4 = incomplete (max steps exceeded, agent didn't finish)
            //   3 = provider error (auth, rate limit, API failure)
            //   1 = generic error (everything else)
            let code = 1;
            if (errCode === "loop.max_steps_exceeded") {
              code = 4;
            } else if (
              errCode === "provider.auth_error" ||
              errCode === "provider.rate_limit" ||
              errCode === "provider.api_error" ||
              errCode === "provider.connection_error"
            ) {
              code = 3;
            }
            finish(new Error(errMsg), code);
          }
        }
        // All other event types are silently ignored.
      });

      session.prompt(userText).catch((error: unknown) => {
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

      await turnPromise;
    }
  } catch (error) {
    // finish() already emitted the result event and set exitCode for
    // expected errors (turn.ended / agent error events). Only emit a
    // result event here for truly unexpected fatal errors that bypassed
    // the event-driven path.
    if (process.exitCode === undefined) {
      log.error("stream-json: fatal", { error });
      writer.emitResult("error", error instanceof Error ? error.message : String(error), writer.getTokenUsage());
      process.exitCode = 1;
    } else {
      log.error("stream-json: turn error (exitCode already set)", { error });
    }
  } finally {
    // Reject any pending approvals so the core doesn't hang on shutdown.
    for (const [, pending] of pendingApprovals) {
      pending.resolve({ decision: "rejected", feedback: "会话已结束" });
    }
    pendingApprovals.clear();

    // Emit resume hint so user knows how to continue
    if (currentSessionId) {
      writer.emitResumeHint(sessionKey);
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

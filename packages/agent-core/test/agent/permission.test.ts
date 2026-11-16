import type { Jian } from '@scream-code/jian';
import type { ToolCall } from '@scream-code/ltod';
import * as posixPath from 'node:path/posix';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import { PermissionModeInjector } from '../../src/agent/injection/permission-mode';
import {
  PermissionManager,
  type ApprovalResponse,
  type PermissionMode,
  type PermissionPolicyContext,
  type PermissionRule,
} from '../../src/agent/permission';
import {
  matchPermissionRule,
  parsePattern,
  type PermissionRuleMatchExecution,
} from '../../src/agent/permission/matches-rule';
import { AutoModeApprovePermissionPolicy } from '../../src/agent/permission/policies/auto-mode-approve';
import { AutoModeAskUserQuestionDenyPermissionPolicy } from '../../src/agent/permission/policies/auto-mode-ask-user-question-deny';
import { FallbackAskPermissionPolicy } from '../../src/agent/permission/policies/fallback-ask';
import { createPermissionDecisionPolicies } from '../../src/agent/permission/policies';
import { YoloModeApprovePermissionPolicy } from '../../src/agent/permission/policies/yolo-mode-approve';
import { ToolAccesses } from '../../src/loop';
import type { ToolInputDisplay } from '../../src/tools/display';
import {
  literalRulePattern,
  matchesPathRuleSubject,
  matchesGlobRuleSubject,
} from '../../src/tools/support/rule-match';
import { createFakeJian } from '../tools/fixtures/fake-jian';
import { createCommandJian, testAgent } from './harness/agent';

describe('Agent permission', () => {
  it('auto mode bypasses approval for ordinary builtin tools', async () => {
    const ctx = testAgent({ jian: createCommandJian('auto-output') });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'Running without asking.' }, bashCall());
    ctx.mockNextResponse({ type: 'text', text: 'The command printed auto-output.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash in auto mode' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.set_mode         { "mode": "auto", "time": "<time>" }
      [emit] agent.status.updated        { "agentId": "main", "model": "mock-model", "thinkingLevel": "off", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "wolfpackMode": false, "rlmEnabled": false, "rlmMaxDepth": null, "permission": "auto" }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Run Bash in auto mode" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Run Bash in auto mode" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "m0" }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" }, "id": "m1" }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] request.header              { "provider": "scream", "model": "mock-model", "modelAlias": "mock-model", "systemPrompt": "You are a deterministic test agent.", "activeTools": [ "Bash" ], "messagesCount": 2, "estimatedInputTokens": "<tokens>", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "Running without asking." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf permission-output\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "block.start", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "index": 0, "blockType": "text" }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "Running without asking." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "block.end", "uuid": "<uuid-4>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "index": 0, "blockType": "text" }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "block.start", "uuid": "<uuid-5>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "index": 0, "blockType": "tool-call" }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf permission-output", "timeout": 60 }, "description": "Running: printf permission-output", "display": { "kind": "command", "command": "printf permission-output", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf permission-output", "timeout": 60 }, "description": "Running: printf permission-output", "display": { "kind": "command", "command": "printf permission-output", "cwd": "<cwd>", "language": "bash" } }
      [wire] context.append_loop_event   { "event": { "type": "block.end", "uuid": "<uuid-6>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "index": 0, "blockType": "tool-call" }, "time": "<time>" }
      [emit] tool.progress               { "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "auto-output" } }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "auto-output", "message": "Command executed successfully." } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_bash", "output": "auto-output", "message": "Command executed successfully." }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 127, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 127, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 127, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "agentId": "main", "model": "mock-model", "thinkingLevel": "off", "contextTokens": 152, "maxContextTokens": 1000000, "contextUsage": 0.000152, "planMode": false, "wolfpackMode": false, "rlmEnabled": false, "rlmMaxDepth": null, "permission": "auto", "usage": { "byModel": { "mock-model": { "inputOther": 127, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 127, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 127, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "turnTotal": { "inputOther": 127, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-7>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 2, "stepId": "<uuid-7>" }
      [wire] request.header              { "provider": "scream", "model": "mock-model", "modelAlias": "mock-model", "systemPromptReused": true, "activeTools": [ "Bash" ], "messagesCount": 4, "estimatedInputTokens": "<tokens>", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "The command printed auto-output." }
      [wire] context.append_loop_event   { "event": { "type": "block.start", "uuid": "<uuid-8>", "turnId": "0", "step": 2, "stepUuid": "<uuid-7>", "index": 0, "blockType": "text" }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-9>", "turnId": "0", "step": 2, "stepUuid": "<uuid-7>", "part": { "type": "text", "text": "The command printed auto-output." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "block.end", "uuid": "<uuid-10>", "turnId": "0", "step": 2, "stepUuid": "<uuid-7>", "index": 0, "blockType": "text" }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-7>", "turnId": "0", "step": 2, "usage": { "inputOther": 156, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 2, "stepId": "<uuid-7>", "usage": { "inputOther": 156, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 156, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "agentId": "main", "model": "mock-model", "thinkingLevel": "off", "contextTokens": 167, "maxContextTokens": 1000000, "contextUsage": 0.000167, "planMode": false, "wolfpackMode": false, "rlmEnabled": false, "rlmMaxDepth": null, "permission": "auto", "usage": { "byModel": { "mock-model": { "inputOther": 283, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 283, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 283, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 }, "turnTotal": { "inputOther": 283, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: Bash
        messages:
          user: text "Run Bash in auto mode"
          user: text <auto-mode-enter-reminder>

      call 2:
        messages:
          <last>
          assistant: text "Running without asking."  calls call_bash:Bash { "command": "printf permission-output", "timeout": 60 }
          tool[call_bash]: text "auto-output"
    `);
    await ctx.expectResumeMatches();
  });

  it('yolo mode bypasses approval for ordinary builtin tools', async () => {
    const ctx = testAgent({ jian: createCommandJian('yolo-output') });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse({ type: 'text', text: 'Running in yolo mode.' }, bashCall());
    ctx.mockNextResponse({ type: 'text', text: 'The command printed yolo-output.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash in yolo mode' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.set_mode         { "mode": "yolo", "time": "<time>" }
      [emit] agent.status.updated        { "agentId": "main", "model": "mock-model", "thinkingLevel": "off", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "wolfpackMode": false, "rlmEnabled": false, "rlmMaxDepth": null, "permission": "yolo" }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Run Bash in yolo mode" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Run Bash in yolo mode" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "m0" }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] request.header              { "provider": "scream", "model": "mock-model", "modelAlias": "mock-model", "systemPrompt": "You are a deterministic test agent.", "activeTools": [ "Bash" ], "messagesCount": 1, "estimatedInputTokens": "<tokens>", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "Running in yolo mode." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf permission-output\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "block.start", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "index": 0, "blockType": "text" }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "Running in yolo mode." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "block.end", "uuid": "<uuid-4>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "index": 0, "blockType": "text" }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "block.start", "uuid": "<uuid-5>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "index": 0, "blockType": "tool-call" }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf permission-output", "timeout": 60 }, "description": "Running: printf permission-output", "display": { "kind": "command", "command": "printf permission-output", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf permission-output", "timeout": 60 }, "description": "Running: printf permission-output", "display": { "kind": "command", "command": "printf permission-output", "cwd": "<cwd>", "language": "bash" } }
      [wire] context.append_loop_event   { "event": { "type": "block.end", "uuid": "<uuid-6>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "index": 0, "blockType": "tool-call" }, "time": "<time>" }
      [emit] tool.progress               { "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "yolo-output" } }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "yolo-output", "message": "Command executed successfully." } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_bash", "output": "yolo-output", "message": "Command executed successfully." }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "agentId": "main", "model": "mock-model", "thinkingLevel": "off", "contextTokens": 32, "maxContextTokens": 1000000, "contextUsage": 0.000032, "planMode": false, "wolfpackMode": false, "rlmEnabled": false, "rlmMaxDepth": null, "permission": "yolo", "usage": { "byModel": { "mock-model": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "turnTotal": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-7>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 2, "stepId": "<uuid-7>" }
      [wire] request.header              { "provider": "scream", "model": "mock-model", "modelAlias": "mock-model", "systemPromptReused": true, "activeTools": [ "Bash" ], "messagesCount": 3, "estimatedInputTokens": "<tokens>", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "The command printed yolo-output." }
      [wire] context.append_loop_event   { "event": { "type": "block.start", "uuid": "<uuid-8>", "turnId": "0", "step": 2, "stepUuid": "<uuid-7>", "index": 0, "blockType": "text" }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-9>", "turnId": "0", "step": 2, "stepUuid": "<uuid-7>", "part": { "type": "text", "text": "The command printed yolo-output." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "block.end", "uuid": "<uuid-10>", "turnId": "0", "step": 2, "stepUuid": "<uuid-7>", "index": 0, "blockType": "text" }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-7>", "turnId": "0", "step": 2, "usage": { "inputOther": 36, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 2, "stepId": "<uuid-7>", "usage": { "inputOther": 36, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 36, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "agentId": "main", "model": "mock-model", "thinkingLevel": "off", "contextTokens": 47, "maxContextTokens": 1000000, "contextUsage": 0.000047, "planMode": false, "wolfpackMode": false, "rlmEnabled": false, "rlmMaxDepth": null, "permission": "yolo", "usage": { "byModel": { "mock-model": { "inputOther": 43, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 43, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 43, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 }, "turnTotal": { "inputOther": 43, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: Bash
        messages:
          user: text "Run Bash in yolo mode"

      call 2:
        messages:
          <last>
          assistant: text "Running in yolo mode."  calls call_bash:Bash { "command": "printf permission-output", "timeout": 60 }
          tool[call_bash]: text "yolo-output"
    `);
    await ctx.expectResumeMatches();
  });
  it('injects a reminder when leaving auto mode', async () => {
    const ctx = testAgent();
    ctx.configure();
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'Auto turn done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use auto first' }] });
    await ctx.untilTurnEnd();

    await ctx.rpc.setPermission({ mode: 'yolo' });
    ctx.mockNextResponse({ type: 'text', text: 'Yolo turn done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Back to yolo' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.set_mode         { "mode": "yolo", "time": "<time>" }
      [emit] agent.status.updated        { "agentId": "main", "model": "mock-model", "thinkingLevel": "off", "contextTokens": 132, "maxContextTokens": 1000000, "contextUsage": 0.000132, "planMode": false, "wolfpackMode": false, "rlmEnabled": false, "rlmMaxDepth": null, "permission": "yolo", "usage": { "byModel": { "mock-model": { "inputOther": 125, "output": 7, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 125, "output": 7, "inputCacheRead": 0, "inputCacheCreation": 0 }, "turnTotal": { "inputOther": 125, "output": 7, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Back to yolo" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 1, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Back to yolo" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "m3" }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-exit-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" }, "id": "m4" }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-5>", "turnId": "1", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 1, "step": 1, "stepId": "<uuid-5>" }
      [wire] request.header              { "provider": "scream", "model": "mock-model", "modelAlias": "mock-model", "systemPromptReused": true, "activeTools": [], "messagesCount": 5, "estimatedInputTokens": "<tokens>", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 1, "delta": "Yolo turn done." }
      [wire] context.append_loop_event   { "event": { "type": "block.start", "uuid": "<uuid-6>", "turnId": "1", "step": 1, "stepUuid": "<uuid-5>", "index": 0, "blockType": "text" }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-7>", "turnId": "1", "step": 1, "stepUuid": "<uuid-5>", "part": { "type": "text", "text": "Yolo turn done." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "block.end", "uuid": "<uuid-8>", "turnId": "1", "step": 1, "stepUuid": "<uuid-5>", "index": 0, "blockType": "text" }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-5>", "turnId": "1", "step": 1, "usage": { "inputOther": 246, "output": 7, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 1, "step": 1, "stepId": "<uuid-5>", "usage": { "inputOther": 246, "output": 7, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 246, "output": 7, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "agentId": "main", "model": "mock-model", "thinkingLevel": "off", "contextTokens": 253, "maxContextTokens": 1000000, "contextUsage": 0.000253, "planMode": false, "wolfpackMode": false, "rlmEnabled": false, "rlmMaxDepth": null, "permission": "yolo", "usage": { "byModel": { "mock-model": { "inputOther": 371, "output": 14, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 371, "output": 14, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 246, "output": 7, "inputCacheRead": 0, "inputCacheCreation": 0 }, "turnTotal": { "inputOther": 371, "output": 14, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 1, "reason": "completed" }
    `);
    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: []
        messages:
          user: text "Use auto first"
          user: text <auto-mode-enter-reminder>

      call 2:
        messages:
          <last>
          assistant: text "Auto turn done."
          user: text "Back to yolo"
          user: text <auto-mode-exit-reminder>
    `);
    await ctx.expectResumeMatches();
  });

  it('does not execute denied mutating tools in ask mode and feeds the denial back to the LLM', async () => {
    const execWithEnv = vi.fn().mockRejectedValue(new Error('Bash should not execute'));
    const bashCall: ToolCall = {
      type: 'function',
      id: 'call_bash',
      name: 'Bash',
      arguments: '{"command":"printf should-not-run","timeout":60}',
    };
    const ctx = testAgent({
      jian: createFakeJian({ execWithEnv }),
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'ask' });

    ctx.mockNextResponse({ type: 'text', text: 'I will try Bash.' }, bashCall);
    ctx.mockNextResponse({ type: 'text', text: 'Ask mode is read-only, so I will answer instead.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Try to run Bash' }] });
    await ctx.untilTurnEnd();

    expect(execWithEnv).not.toHaveBeenCalled();
    expect(JSON.stringify(ctx.agent.context.history)).toContain('not available in Ask mode');
  });

});

describe('Permission auto mode', () => {
  it('tells the agent not to ask questions in auto mode', async () => {
    const appendSystemReminder = vi.fn();
    const agent = {
      permission: { mode: 'auto' },
      context: { history: [], appendSystemReminder },
    } as unknown as Agent;
    const injector = new PermissionModeInjector(agent);

    await injector.inject();

    expect(appendSystemReminder).toHaveBeenCalledWith(
      expect.stringContaining('Do NOT call AskUserQuestion while auto mode is active'),
      { kind: 'injection', variant: 'permission_mode' },
    );
  });

  it('announces bot mode with the unattended-execution rules', async () => {
    const appendSystemReminder = vi.fn();
    const agent = {
      permission: { mode: 'bot' },
      context: { history: [], appendSystemReminder },
    } as unknown as Agent;
    const injector = new PermissionModeInjector(agent);

    await injector.inject();

    expect(appendSystemReminder).toHaveBeenCalledWith(
      expect.stringContaining('Bot permission mode is active'),
      { kind: 'injection', variant: 'permission_mode' },
    );
    expect(appendSystemReminder).toHaveBeenCalledWith(
      expect.stringContaining('Do not retry a denied call unchanged'),
      expect.anything(),
    );
  });

  it('announces yolo mode and its destructive-action caveat on a real transition', async () => {
    const appendSystemReminder = vi.fn();
    const agent = {
      permission: { mode: 'auto' },
      context: { history: [], appendSystemReminder },
    } as unknown as Agent;
    const injector = new PermissionModeInjector(agent);

    // auto at session start announces auto, not yolo.
    await injector.inject();
    appendSystemReminder.mockClear();

    (agent.permission as { mode: string }).mode = 'yolo';
    await injector.inject();

    expect(appendSystemReminder).toHaveBeenCalledWith(
      expect.stringContaining('Yolo permission mode is active'),
      { kind: 'injection', variant: 'permission_mode' },
    );
    expect(appendSystemReminder).toHaveBeenCalledWith(
      expect.stringContaining('verify destructive operations yourself'),
      expect.anything(),
    );
  });

  it('announces a return to yolo mode only on a real transition', async () => {
    const appendSystemReminder = vi.fn();
    const agent = {
      permission: { mode: 'yolo' },
      context: { history: [], appendSystemReminder },
    } as unknown as Agent;
    const injector = new PermissionModeInjector(agent);

    // Session start in yolo mode — the default: nothing to announce.
    await injector.inject();
    expect(appendSystemReminder).not.toHaveBeenCalled();

    (agent.permission as { mode: string }).mode = 'auto';
    await injector.inject();

    appendSystemReminder.mockClear();
    (agent.permission as { mode: string }).mode = 'yolo';
    await injector.inject();

    expect(appendSystemReminder).toHaveBeenCalledWith(
      expect.stringContaining('Yolo permission mode is active'),
      expect.anything(),
    );
  });

  it('blocks AskUserQuestion in auto mode before execution', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('auto');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_question',
          toolName: 'AskUserQuestion',
          args: { questions: [] },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining(
        'AskUserQuestion is unavailable in auto permission mode',
      ),
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('allows AskUserQuestion in yolo mode so it can reach question rpc', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('yolo');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_question',
          toolName: 'AskUserQuestion',
          args: { questions: [] },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each(['auto', 'yolo'] as const)('applies deny rules before %s mode bypass', async (mode) => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode(mode);
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'blocked by test',
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_1' }))).resolves.toMatchObject({
      block: true,
      reason: 'Tool "Bash" was denied by permission rule. Reason: blocked by test',
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each([
    ['auto', 'auto-mode-approve'],
    ['yolo', 'yolo-mode-approve'],
  ] as const)('tracks %s mode bypass through %s', async (mode, policyName) => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode(mode);

    await expect(manager.beforeToolCall(hookContext({ id: 'call_1' }))).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });

  it('tracks plan-mode Bash bypass in auto mode through auto-mode-approve', async () => {
    const { manager, requestApproval } = makePermissionManager(
      async () => ({
        decision: 'approved',
      }),
      { planModeActive: true },
    );
    manager.setMode('auto');

    await expect(manager.beforeToolCall(hookContext({ id: 'call_plan_bash' }))).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });

  it.each(['auto', 'yolo'] as const)(
    'tracks mode policy for default-allowed tools in %s mode',
    async (mode) => {
      const { manager, requestApproval } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.setMode(mode);

      await expect(
        manager.beforeToolCall(
          hookContext({
            id: 'call_read',
            toolName: 'Read',
            args: { path: '/workspace/notes.md' },
          }),
        ),
      ).resolves.toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
      
    },
  );

  it.each(
    (['yolo'] as const).flatMap((mode) =>
      [
        [mode, 'Write', { path: '/tmp/notes.md', content: 'x' }, 'write', 'write file'],
        [mode, 'Edit', { path: '/tmp/notes.md', old_string: 'a', new_string: 'b' }, 'edit', 'edit file'],
      ] as const,
    ),
  )(
    'approves %s outside the cwd in %s mode without prompting',
    async (mode, toolName, args, _operation, _action) => {
      const { manager, requestApproval } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.setMode(mode);

      await expect(
        manager.beforeToolCall(hookContext({ id: `call_${toolName}`, toolName, args })),
      ).resolves.toBeUndefined();

      // The prompt posture is gone: writes outside the cwd no longer ask, the
      // mode policy approves them instead.
      expect(requestApproval).not.toHaveBeenCalled();
    },
  );

  it.each(
    (['auto', 'yolo'] as const).flatMap((mode) =>
      [
        [mode, 'Read', { path: '/tmp/notes.md' }],
        [mode, 'ReadMediaFile', { path: '/tmp/image.png' }],
        [mode, 'Grep', { pattern: 'TODO', path: '/tmp' }],
      ] as const,
    ),
  )(
    'does not ask in %s mode for %s outside the cwd (read/search are not write)',
    async (mode, toolName, args) => {
      const { manager, requestApproval } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.setMode(mode);

      await expect(
        manager.beforeToolCall(hookContext({ id: `call_${toolName}_${mode}`, toolName, args })),
      ).resolves.toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
    },
  );

  it.each(
    (['auto', 'yolo'] as const).flatMap((mode) =>
      [
        ['Read', mode, { path: '/tmp/notes.md' }],
        ['ReadMediaFile', mode, { path: '/tmp/image.png' }],
        ['Write', mode, { path: '/tmp/notes.md', content: 'x' }],
        ['Edit', mode, { path: '/tmp/notes.md', old_string: 'a', new_string: 'b' }],
      ] as const,
    ),
  )('approves %s outside the cwd in %s mode', async (toolName, mode, args) => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode(mode);

    await expect(
      manager.beforeToolCall(hookContext({ id: `call_${toolName}`, toolName, args })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });

  it.each([
    ['Read', { path: '/workspace/notes.md' }],
    ['ReadMediaFile', { path: '/workspace/image.png' }],
    ['Write', { path: '/workspace/notes.md', content: 'x' }],
    ['Edit', { path: '/workspace/notes.md', old_string: 'a', new_string: 'b' }],
    ['Grep', { pattern: 'TODO', path: '/workspace' }],
  ] as const)(
    'does not request approval for %s inside the workspace in yolo mode',
    async (toolName, args) => {
      const { manager, requestApproval } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.setMode('yolo');

      await expect(
        manager.beforeToolCall(hookContext({ id: `call_${toolName}`, toolName, args })),
      ).resolves.toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
    },
  );

  it('approves Grep search outside the cwd in auto mode', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('auto');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_grep_auto',
          toolName: 'Grep',
          args: { pattern: 'TODO', path: '/tmp' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });

  it('keeps explicit deny rules higher priority than yolo outside-workspace approval', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('yolo');
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Read',
      reason: 'reads disabled',
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_read_denied',
          toolName: 'Read',
          args: { path: '/tmp/notes.md' },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: 'Tool "Read" was denied by permission rule. Reason: reads disabled',
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('keeps ask rules higher priority than matching allow rules', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    // ask mode is the only surviving posture where a user ask rule can fire:
    // mutating tools are denied by the read-only guard before the rule chain.
    manager.setMode('ask');
    manager.rules.push(
      {
        decision: 'allow',
        scope: 'project',
        pattern: 'Read',
      },
      {
        decision: 'ask',
        scope: 'user',
        pattern: 'Read',
      },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_read_ask_allow',
          toolName: 'Read',
          args: { path: '/workspace/notes.md' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('reuses approve-for-session even when an ask rule still matches the call', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));
    manager.setMode('ask');
    manager.rules.push({
      decision: 'ask',
      scope: 'user',
      pattern: 'Read',
    });
    const call = () =>
      manager.beforeToolCall(
        hookContext({
          id: 'call_read_session_after_ask',
          toolName: 'Read',
          args: { path: '/workspace/notes.md' },
        }),
      );

    await expect(call()).resolves.toBeUndefined();
    await expect(call()).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('approves outside-workspace writes in yolo mode without prompting', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));
    manager.setMode('yolo');
    const call = () =>
      manager.beforeToolCall(
        hookContext({
          id: 'call_write_session',
          toolName: 'Write',
          args: { path: '/tmp/notes.md', content: 'x' },
        }),
      );

    await expect(call()).resolves.toBeUndefined();
    await expect(call()).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(manager.sessionApprovalRulePatterns).toEqual([]);
    expect(manager.data().rules).toEqual([]);
  });
});

describe('Permission policy chain', () => {
  it('keeps built-in policies in document order', () => {
    expect(createPermissionDecisionPolicies({} as Agent).map((policy) => policy.name)).toEqual([
      'pre-tool-call-hook',
      'capability-guard-deny',
      'auto-mode-ask-user-question-deny',
      'plan-mode-guard-deny',
      'ask-mode-guard-deny',
      'user-configured-deny',
      'ask-mode-readonly-mcp-approve',
      'bot-mode-permission',
      'collaboration-auto-approve',
      'auto-mode-approve',
      'yolo-hard-floor-ask',
      'yolo-mode-approve',
      'private-read-egress-ask',
      'dangerous-command-warnings-ask',
      'session-approval-history',
      'user-configured-ask',
      'user-configured-allow',
      'exit-plan-mode-review-ask',
      'plan-mode-tool-approve',
      'sensitive-file-access-ask',
      'git-control-path-access-ask',
      'cwd-outside-file-write-ask',
      'wolfpack-mode-approve',
      'destructive-hint-ask',
      'default-tool-approve',
      'manage-plugin-read-only-approve',
      'git-cwd-write-approve',
      'fallback-ask',
    ]);
  });

});

describe('Simple permission policy direct behavior', () => {
  it('approves only in auto mode for AutoModeApprovePermissionPolicy', () => {
    const agent = { permission: { mode: 'yolo' } } as unknown as Agent;
    const policy = new AutoModeApprovePermissionPolicy(agent);

    expect(policy.evaluate()).toBeUndefined();
    Object.assign(agent.permission, { mode: 'auto' });
    expect(policy.evaluate()).toEqual({ kind: 'approve' });
  });

  it('denies AskUserQuestion only in auto mode', () => {
    const agent = { permission: { mode: 'yolo' } } as unknown as Agent;
    const policy = new AutoModeAskUserQuestionDenyPermissionPolicy(agent);

    expect(
      policy.evaluate(
        hookContext({
          id: 'call_question_manual',
          toolName: 'AskUserQuestion',
          args: { questions: [] },
        }),
      ),
    ).toBeUndefined();

    Object.assign(agent.permission, { mode: 'auto' });
    expect(
      policy.evaluate(
        hookContext({
          id: 'call_question_auto',
          toolName: 'AskUserQuestion',
          args: { questions: [] },
        }),
      ),
    ).toMatchObject({ kind: 'deny' });
    expect(
      policy.evaluate(
        hookContext({
          id: 'call_bash_auto',
          toolName: 'Bash',
        }),
      ),
    ).toBeUndefined();
  });

  it('approves only in yolo mode for YoloModeApprovePermissionPolicy', () => {
    const agent = { permission: { mode: 'ask' } } as unknown as Agent;
    const policy = new YoloModeApprovePermissionPolicy(agent);
    const bash = hookContext({ id: 'call_bash_yolo', toolName: 'Bash' });

    expect(policy.evaluate(bash)).toBeUndefined();
    Object.assign(agent.permission, { mode: 'yolo' });
    expect(policy.evaluate(bash)).toEqual({ kind: 'approve' });
    // ExitPlanMode is exempt — plan decisions stay with the user in yolo.
    expect(
      policy.evaluate(hookContext({ id: 'call_exit_plan_yolo', toolName: 'ExitPlanMode' })),
    ).toBeUndefined();
  });

  it('always asks in FallbackAskPermissionPolicy', () => {
    const policy = new FallbackAskPermissionPolicy();

    expect(policy.evaluate(hookContext({ id: 'call_fallback_direct' }))).toEqual({ kind: 'ask' });
  });
});

describe('PreToolUse permission policy', () => {
  it('blocks before approval and records the hook policy decision', async () => {
    const triggerBlock = vi.fn(async () => ({
      block: true,
      reason: 'blocked by hook',
    }));
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { hooks: { triggerBlock } as unknown as Agent['hooks'] },
    );

    await expect(manager.beforeToolCall(hookContext({ id: 'call_hook_block' }))).resolves
      .toMatchObject({
        block: true,
        reason: 'blocked by hook',
      });

    expect(requestApproval).not.toHaveBeenCalled();
    expect(triggerBlock).toHaveBeenCalledWith('PreToolUse', {
      matcherValue: 'Bash',
      signal: expect.any(AbortSignal),
      inputData: {
        toolName: 'Bash',
        toolInput: { command: 'printf first', timeout: 60 },
        toolCallId: 'call_hook_block',
      },
    });
    
  });

  it.each(['auto', 'yolo'] as const)('runs before %s mode bypass', async (mode) => {
    const triggerBlock = vi.fn(async () => ({
      block: true,
      reason: `${mode} hook block`,
    }));
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { hooks: { triggerBlock } as unknown as Agent['hooks'] },
    );
    manager.setMode(mode);

    await expect(manager.beforeToolCall(hookContext({ id: `call_hook_${mode}` }))).resolves
      .toMatchObject({
        block: true,
        reason: `${mode} hook block`,
      });

    expect(requestApproval).not.toHaveBeenCalled();
    
  });

  it('continues through later policies when the hook does not block', async () => {
    const triggerBlock = vi.fn(async () => undefined);
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { hooks: { triggerBlock } as unknown as Agent['hooks'] },
    );
    // The ask-mode read-only guard sits below the hook: Bash reaching it is
    // proof the chain continued past a non-blocking PreToolUse hook.
    manager.setMode('ask');

    await expect(manager.beforeToolCall(hookContext({ id: 'call_hook_allow' }))).resolves
      .toMatchObject({
        block: true,
        reason: expect.stringContaining('not available in Ask mode'),
      });

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('passes an empty hook input object for non-plain arguments', async () => {
    const triggerBlock = vi.fn(async () => ({
      block: true,
      reason: 'array args blocked',
    }));
    const { manager } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { hooks: { triggerBlock } as unknown as Agent['hooks'] },
    );

    await manager.beforeToolCall(
      hookContext({
        id: 'call_array_args',
        toolName: 'Custom',
        args: [] as unknown as Record<string, unknown>,
      }),
    );

    expect(triggerBlock).toHaveBeenCalledWith(
      'PreToolUse',
      expect.objectContaining({
        inputData: {
          toolName: 'Custom',
          toolInput: {},
          toolCallId: 'call_array_args',
        },
      }),
    );
  });
});

describe('Default tool approve policy', () => {
  it.each([
    ['Read', { path: '/workspace/notes.md' }],
    ['Grep', { pattern: 'TODO', path: '/workspace' }],
    ['Glob', { pattern: '**/*.ts', path: '/workspace' }],
    ['ReadMediaFile', { path: '/workspace/image.png' }],
    ['SetTodoList', { items: [] }],
    ['TodoList', {}],
    ['TaskList', {}],
    ['TaskOutput', { task_id: 'task_1' }],
    ['WebSearch', { query: 'scream code' }],
    ['FetchURL', { url: 'https://example.com' }],
    ['Agent', { prompt: 'review this' }],
    ['AskUserQuestion', { questions: [] }],
    ['Skill', { name: 'test-skill' }],
  ] as const)('approves %s in ask mode without requesting approval', async (toolName, args) => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    // ask mode is the surviving mode where a read/dialogue tool must still be
    // approved by the catalog rather than by a blanket mode policy.
    manager.setMode('ask');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: `call_default_${toolName}`,
          toolName,
          args,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each([
    ['Bash', { command: 'printf first', timeout: 60 }],
    ['Write', { path: '/workspace/a.ts', content: 'x' }],
    ['Edit', { path: '/workspace/a.ts', old_string: 'a', new_string: 'b' }],
  ] as const)('denies %s in ask mode instead of default-approving it', async (toolName, args) => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('ask');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: `call_not_default_${toolName}`,
          toolName,
          args,
        }),
      ),
    ).resolves.toMatchObject({ block: true });

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('falls back to an approval for a tool outside the default-approve catalog', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('ask');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_not_default_Custom',
          toolName: 'Custom',
          args: { value: 1 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('keeps auto-mode AskUserQuestion deny above default approval', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('auto');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_auto_question_default',
          toolName: 'AskUserQuestion',
          args: { questions: [] },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('AskUserQuestion is unavailable in auto permission mode'),
    });

    expect(requestApproval).not.toHaveBeenCalled();
    
  });
});

describe('Permission live derive', () => {
  it('derives parent mode until the child records a local mode', () => {
    const parent = makePermissionManager(async () => ({ decision: 'approved' }));
    const child = makePermissionManager(async () => ({ decision: 'approved' }), {
      parent: parent.manager,
    });

    expect(child.manager.mode).toBe('yolo');
    parent.manager.setMode('ask');
    expect(child.manager.mode).toBe('ask');
    expect(child.manager.data().mode).toBe('ask');

    child.manager.setMode('bot');
    parent.manager.setMode('auto');
    expect(child.manager.mode).toBe('bot');
  });

  it('applies rule decision priority across child and parent rules', async () => {
    const parent = makePermissionManager(async () => ({ decision: 'approved' }));
    parent.manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'parent deny',
    });
    const child = makePermissionManager(async () => ({ decision: 'approved' }), {
      parent: parent.manager,
    });
    child.manager.rules.push({
      decision: 'allow',
      scope: 'session-runtime',
      pattern: 'Bash',
      reason: 'child allow',
    });

    await expect(child.manager.beforeToolCall(hookContext({ id: 'call_parent_deny' }))).resolves
      .toMatchObject({
        block: true,
        reason: 'Tool "Bash" was denied by permission rule. Reason: parent deny',
      });
    expect(child.requestApproval).not.toHaveBeenCalled();

    const parentAllow = makePermissionManager(async () => ({ decision: 'approved' }));
    parentAllow.manager.rules.push({
      decision: 'allow',
      scope: 'user',
      pattern: 'Bash',
      reason: 'parent allow',
    });
    const childDeny = makePermissionManager(async () => ({ decision: 'approved' }), {
      parent: parentAllow.manager,
    });
    childDeny.manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'child deny',
    });

    await expect(childDeny.manager.beforeToolCall(hookContext({ id: 'call_deny' }))).resolves
      .toMatchObject({
        block: true,
        reason: 'Tool "Bash" was denied by permission rule. Reason: child deny',
      });
    expect(childDeny.requestApproval).not.toHaveBeenCalled();
  });

  it('ignores legacy session-runtime rules in user-configured matching', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push({
      decision: 'allow',
      scope: 'session-runtime',
      pattern: 'Bash',
      reason: 'legacy approve for session',
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_legacy_session_rule' }))).resolves
      .toBeUndefined();

    // The legacy rule never matches — the call approves via the default yolo
    // posture instead of asking again.
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('falls back to parent rules and session approvals when no child rule matches', async () => {
    const parent = makePermissionManager(async () => ({ decision: 'approved' }));
    parent.manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_parent',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(printf first)',
      result: {
        decision: 'approved',
        scope: 'session',
        selectedLabel: 'Approve for this session',
      },
    });
    const child = makePermissionManager(async () => ({ decision: 'approved' }), {
      parent: parent.manager,
    });

    await expect(child.manager.beforeToolCall(hookContext({ id: 'call_child' }))).resolves
      .toBeUndefined();

    expect(child.requestApproval).not.toHaveBeenCalled();
    expect(child.manager.rules).toEqual([]);
    expect(child.manager.data().rules).toEqual([]);
    expect(child.manager.sessionApprovalRulePatterns).toContain('Bash(printf first)');
  });

  it('uses child local mode for inherited non-deny decisions', async () => {
    const parent = makePermissionManager(async () => ({ decision: 'approved' }));
    parent.manager.setMode('yolo');
    const child = makePermissionManager(async () => ({ decision: 'approved' }), {
      parent: parent.manager,
    });

    await expect(child.manager.beforeToolCall(hookContext({ id: 'call_inherited_yolo' }))).resolves
      .toBeUndefined();
    expect(child.requestApproval).not.toHaveBeenCalled();

    child.manager.setMode('ask');
    await expect(child.manager.beforeToolCall(hookContext({ id: 'call_local_ask' }))).resolves
      .toMatchObject({ block: true });
    expect(child.requestApproval).not.toHaveBeenCalled();
  });
});

describe('User-configured permission policies', () => {
  it('denies with argument-aware matching and ignores non-matching arguments', async () => {
    const denied = makePermissionManager(async () => ({ decision: 'approved' }));
    denied.manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash(git *)',
      reason: 'git is blocked',
    });

    await expect(
      denied.manager.beforeToolCall(
        hookContext({
          id: 'call_git_denied',
          args: { command: 'git status', timeout: 60 },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: 'Tool "Bash" was denied by permission rule. Reason: git is blocked',
    });
    expect(denied.requestApproval).not.toHaveBeenCalled();

    const allowed = makePermissionManager(async () => ({ decision: 'approved' }));
    allowed.manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash(git *)',
      reason: 'git is blocked',
    });

    await expect(
      allowed.manager.beforeToolCall(
        hookContext({
          id: 'call_npm_not_denied',
          args: { command: 'npm test', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();
    // The non-matching deny rule leaves the call to the default yolo posture.
    expect(allowed.requestApproval).not.toHaveBeenCalled();
  });

  it.each([
    [{ reason: undefined }, 'Tool "Bash" was denied by permission rule.'],
    [{ reason: '' }, 'Tool "Bash" was denied by permission rule.'],
  ] as const)('formats deny messages without an empty reason suffix', async (rule, message) => {
    const { manager } = makePermissionManager(async () => ({ decision: 'approved' }));
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: rule.reason,
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_deny_reason' }))).resolves
      .toMatchObject({
        block: true,
        reason: message,
      });
  });

  it('continues past malformed user rule patterns', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash(git *',
      reason: 'malformed rule',
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_bad_rule' }))).resolves
      .toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('uses the first matching deny rule in effective order', async () => {
    const { manager } = makePermissionManager(async () => ({ decision: 'approved' }));
    manager.rules.push(
      {
        decision: 'deny',
        scope: 'project',
        pattern: 'Bash(git *)',
        reason: 'project deny',
      },
      {
        decision: 'deny',
        scope: 'user',
        pattern: 'Bash(git status)',
        reason: 'user deny',
      },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_first_deny',
          args: { command: 'git status', timeout: 60 },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: 'Tool "Bash" was denied by permission rule. Reason: project deny',
    });
  });

  it('adds sub-agent guidance to user-configured deny messages', async () => {
    const { manager } = makePermissionManager(async () => ({ decision: 'approved' }), {
      agentType: 'sub',
    });
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'blocked by parent',
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_sub_deny' }))).resolves
      .toMatchObject({
        block: true,
        reason: expect.stringContaining("don't retry the same call"),
      });
  });

  it('warns once when ask rules cannot prompt in the current mode', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      makePermissionManager(async () => ({ decision: 'approved' }), {
        initialRules: [{ decision: 'ask', scope: 'user', pattern: 'Bash(git push *)' }],
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('Bash(git push *)');

      // ask mode is where the rule still works: no warning there.
      warn.mockClear();
      const { manager } = makePermissionManager(async () => ({ decision: 'approved' }), {
        initialRules: [{ decision: 'ask', scope: 'user', pattern: 'Bash(git push *)' }],
        mode: 'ask',
      });
      expect(manager.mode).toBe('ask');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('requests approval for argument-aware ask rules with non-sensitive match details', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    // Read survives the ask-mode guard, so a user ask rule is reachable there.
    manager.setMode('ask');
    manager.rules.push({
      decision: 'ask',
      scope: 'user',
      pattern: 'Read(/workspace/**)',
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_ask_git',
          toolName: 'Read',
          args: { path: '/workspace/src/app.ts' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('lets non-matching ask rules fall through to matching allow rules', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push(
      {
        decision: 'ask',
        scope: 'user',
        pattern: 'Bash(git *)',
      },
      {
        decision: 'allow',
        scope: 'user',
        pattern: 'Bash(npm *)',
      },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_allow_npm',
          args: { command: 'npm test', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });

  it('does not grant when an allow rule argument does not match', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push({
      decision: 'allow',
      scope: 'user',
      pattern: 'Bash(git *)',
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_allow_miss',
          args: { command: 'npm test', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each(['turn-override', 'project', 'user'] as const)(
    'matches %s scoped user-configured rules',
    async (scope) => {
      const { manager, requestApproval } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.rules.push({
        decision: 'allow',
        scope,
        pattern: 'Bash',
      });

      await expect(manager.beforeToolCall(hookContext({ id: `call_scope_${scope}` }))).resolves
        .toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
      
    },
  );
});

describe('Plan mode tool approve policy', () => {
  it('approves EnterPlanMode in the default yolo mode without requesting approval', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_enter_plan',
          toolName: 'EnterPlanMode',
          args: {},
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });

  it.each(['Write', 'Edit'] as const)(
    'approves %s when it only writes the active plan file',
    async (toolName) => {
      const planFilePath = '/workspace/.scream/plans/current.md';
      const { manager, requestApproval } = makePermissionManager(
        async () => ({ decision: 'approved' }),
        { planModeActive: true, planFilePath },
      );
      const args =
        toolName === 'Write'
          ? { path: planFilePath, content: '# Plan' }
          : { path: planFilePath, old_string: '# Draft', new_string: '# Plan' };

      await expect(
        manager.beforeToolCall(
          hookContext({
            id: `call_${toolName}_plan_approve`,
            toolName,
            args,
          }),
        ),
      ).resolves.toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
      
    },
  );

  it('denies active plan-mode writes that have no file write access', async () => {
    const planFilePath = '/workspace/.scream/plans/current.md';
    const args = { path: planFilePath, content: '# Plan' };
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { planModeActive: true, planFilePath },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_write_no_access',
          toolName: 'Write',
          args,
          execution: {
            ...testExecution('Write', args),
            accesses: ToolAccesses.none(),
          },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('Plan mode is active'),
    });

    expect(requestApproval).not.toHaveBeenCalled();
    
  });

  it('approves ExitPlanMode directly when plan mode is inactive', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit_inactive',
          toolName: 'ExitPlanMode',
          args: {},
          execution: planReviewExecution({ plan: '# Plan', path: '/tmp/plan.md' }),
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });

  it('approves ExitPlanMode while active when there is no plan review display', async () => {
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { planModeActive: true, planFilePath: '/tmp/plan.md' },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit_generic_display',
          toolName: 'ExitPlanMode',
          args: {},
          execution: {
            ...testExecution('ExitPlanMode', {}),
            display: genericDisplay(),
            approvalRule: 'ExitPlanMode',
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });

  it('approves ExitPlanMode while active when the plan review is blank', async () => {
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { planModeActive: true, planFilePath: '/tmp/plan.md' },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit_blank_plan',
          toolName: 'ExitPlanMode',
          args: {},
          execution: planReviewExecution({ plan: '  \n\t', path: '/tmp/plan.md' }),
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });

  it('defers non-empty plan reviews to the review approval policy', async () => {
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { planModeActive: true, planFilePath: '/tmp/plan.md' },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit_review',
          toolName: 'ExitPlanMode',
          args: {},
          execution: planReviewExecution({ plan: '# Plan', path: '/tmp/plan.md' }),
        }),
      ),
    ).resolves.toMatchObject({
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('Exited plan mode.'),
      },
    });

    expect(requestApproval).toHaveBeenCalledTimes(1);
    
  });
});

describe('Plan mode Bash permission policy', () => {
  it('approves Bash in yolo plan mode without requesting approval', async () => {
    const { manager, requestApproval } = makePlanPermissionManager({
      mode: 'yolo',
      approval: { decision: 'approved' },
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_plan_bash',
          toolName: 'Bash',
          args: { command: 'ls -la', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each(['yolo', 'auto'] as const)(
    'defers Bash to ordinary %s permission behavior in plan mode',
    async (mode) => {
      const { manager, requestApproval } = makePlanPermissionManager({
        mode,
        approval: { decision: 'rejected' },
      });

      await expect(
        manager.beforeToolCall(
          hookContext({
            id: 'call_plan_bash',
            toolName: 'Bash',
            args: { command: 'rm generated.txt', timeout: 60 },
          }),
        ),
      ).resolves.toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
    },
  );
});

describe('ExitPlanMode permission policy', () => {
  const planOptions = [
    { label: 'Approach A', description: 'Use the small change.' },
    { label: 'Approach B', description: 'Use the complete refactor.' },
  ];

  it('allows ExitPlanMode directly in auto mode without requesting approval', async () => {
    const { manager, requestApproval } = makePlanPermissionManager({
      mode: 'auto',
      plan: '# Auto Plan',
    });

    const result = await manager.beforeToolCall(
      hookContext({ id: 'call_exit', toolName: 'ExitPlanMode', args: {} }),
    );

    expect(result).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('requests plan-review approval in yolo mode and returns formatted output', async () => {
    const { manager, record, requestApproval, exit } = makePlanPermissionManager({
      mode: 'yolo',
      plan: '# Plan\n\n- Step',
      path: '/tmp/plan.md',
      approval: { decision: 'approved', selectedLabel: 'Approach B' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit',
        toolName: 'ExitPlanMode',
        args: { options: planOptions },
        execution: planReviewExecution({
          plan: '# Plan\n\n- Step',
          path: '/tmp/plan.md',
          options: planOptions,
        }),
      }),
    );

    expect(requestApproval).toHaveBeenCalledWith(
      {
        turnId: 0,
        toolCallId: 'call_exit',
        toolName: 'ExitPlanMode',
        action: 'Presenting plan and exiting plan mode',
        display: {
          kind: 'plan_review',
          plan: '# Plan\n\n- Step',
          path: '/tmp/plan.md',
          options: planOptions,
        },
        sourceAgentId: 'main',
        sourceToolName: 'ExitPlanMode',
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(record).toHaveBeenCalledWith({
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_exit',
      toolName: 'ExitPlanMode',
      action: 'Presenting plan and exiting plan mode',
      sessionApprovalRule: undefined,
      result: { decision: 'approved', selectedLabel: 'Approach B' },
    });
    expect(exit).toHaveBeenCalled();
    expect(result).toMatchObject({
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('Selected approach: Approach B'),
      },
    });
  });

  it('reuses session approval for ExitPlanMode without re-prompting plan review', async () => {
    const { manager, requestApproval, exit } = makePlanPermissionManager({
      mode: 'yolo',
      plan: '# Updated Plan',
      approval: { decision: 'approved' },
    });
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'previous_exit',
      toolName: 'ExitPlanMode',
      action: 'Presenting plan and exiting plan mode',
      sessionApprovalRule: 'ExitPlanMode',
      result: { decision: 'approved', scope: 'session' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Updated Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(requestApproval).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('returns a synthetic stop-turn result when the user rejects the plan', async () => {
    const { manager, exit } = makePlanPermissionManager({
      mode: 'yolo',
      plan: '# Draft Plan',
      approval: { decision: 'rejected', selectedLabel: 'Reject' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(exit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      syntheticResult: {
        isError: true,
        stopTurn: true,
        output: 'Plan rejected by user. Plan mode remains active.',
      },
    });
  });

  it('keeps plan mode active when plan approval is cancelled', async () => {
    const { manager, exit } = makePlanPermissionManager({
      mode: 'yolo',
      plan: '# Draft Plan',
      approval: { decision: 'cancelled', feedback: 'dismissed' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(exit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      syntheticResult: {
        isError: false,
        output: 'Plan approval dismissed. Plan mode remains active.',
      },
    });
  });

  it('runs the ExitPlanMode cancellation resolver when no approval handler exists', async () => {
    const { manager, exit, record } = makePlanPermissionManager({
      mode: 'yolo',
      plan: '# Draft Plan',
      approvalHandlerAvailable: false,
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit_no_handler',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(exit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      syntheticResult: {
        isError: false,
        output: 'Plan approval dismissed. Plan mode remains active.',
      },
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'permission.record_approval_result',
        result: {
          decision: 'cancelled',
          feedback: 'Approval handler is unavailable.',
        },
      }),
    );
  });

  it('keeps plan mode active when plan approval request fails', async () => {
    const { manager, exit, record } = makePlanPermissionManager({
      mode: 'yolo',
      plan: '# Draft Plan',
      approvalError: new Error('approval transport closed'),
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit',
          toolName: 'ExitPlanMode',
          args: {},
          execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
        }),
      ),
    ).rejects.toThrow('approval transport closed');

    expect(exit).not.toHaveBeenCalled();
    // The aborted approval writes its own audit record; nothing else may be
    // recorded on this path.
    expect(
      record.mock.calls
        .map((call) => call[0] as { type?: string })
        .filter((entry) => entry.type !== 'permission.record_decision'),
    ).toEqual([]);
  });

  it('keeps plan mode active and returns revision feedback as a synthetic result', async () => {
    const { manager, exit } = makePlanPermissionManager({
      mode: 'yolo',
      plan: '# Draft Plan',
      approval: {
        decision: 'rejected',
        selectedLabel: 'Revise',
        feedback: 'Add verification.',
      },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(exit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('Add verification.'),
      },
    });
  });

  it('returns approved plan output without a saved-to line when display has no path', async () => {
    const { manager } = makePlanPermissionManager({
      mode: 'yolo',
      plan: '# Draft Plan',
      approval: { decision: 'approved' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit_no_path',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan' }),
      }),
    );

    expect(result).toMatchObject({
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('## Approved Plan:\n# Draft Plan'),
      },
    });
    expect(result?.syntheticResult?.output).not.toContain('Plan saved to:');
  });

  it('does not force a selected-approach prefix for labels that are not in the options', async () => {
    const { manager } = makePlanPermissionManager({
      mode: 'yolo',
      plan: '# Draft Plan',
      approval: { decision: 'approved', selectedLabel: 'Approach C' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit_unknown_option',
        toolName: 'ExitPlanMode',
        args: { options: planOptions },
        execution: planReviewExecution({
          plan: '# Draft Plan',
          path: '/tmp/plan.md',
          options: planOptions,
        }),
      }),
    );

    expect(result?.syntheticResult?.output).not.toContain('Selected approach:');
    
  });

  it('returns the exit failure when reject-and-exit cannot leave plan mode', async () => {
    const { manager, exit } = makePlanPermissionManager({
      mode: 'yolo',
      plan: '# Draft Plan',
      approval: { decision: 'rejected', selectedLabel: 'Reject and Exit' },
    });
    exit.mockImplementation(() => {
      throw new Error('state transition failure');
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit_reject_exit_failure',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(result).toMatchObject({
      syntheticResult: {
        isError: true,
        output: 'Failed to exit plan mode: state transition failure',
      },
    });
  });

  it('tracks approval transport errors before rethrowing', async () => {
    const { manager } = makePlanPermissionManager({
      mode: 'yolo',
      plan: '# Draft Plan',
      approvalError: new Error('approval transport closed'),
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit_approval_error',
          toolName: 'ExitPlanMode',
          args: {},
          execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
        }),
      ),
    ).rejects.toThrow('approval transport closed');

    
  });
});

describe('Agent-local approve for session', () => {
  it('turns approved session-scoped responses into an agent-local runtime rule cache', async () => {
    const { manager, record, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));
    // ask mode plus a user ask rule is the surviving prompt path: Read passes
    // the read-only guard and reaches the argument-aware ask rule.
    manager.setMode('ask');
    manager.rules.push({ decision: 'ask', scope: 'user', pattern: 'Read(/workspace/**)' });
    const firstArgs = { path: '/workspace/src/app.ts' };
    const firstRule = 'Read(/workspace/src/app.ts)';

    await expect(
      manager.beforeToolCall(
        hookContext({ id: 'call_1', toolName: 'Read', args: firstArgs }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_1',
      toolName: 'Read',
      action: 'read file',
      sessionApprovalRule: firstRule,
      result: {
        decision: 'approved',
        scope: 'session',
        selectedLabel: 'Approve for this session',
      },
    });
    expect(manager.data().rules.filter((rule) => rule.scope === 'session-runtime')).toEqual([]);
    expect(manager.sessionApprovalRulePatterns).toContain(firstRule);

    await expect(
      manager.beforeToolCall(
        hookContext({ id: 'call_2', toolName: 'Read', args: firstArgs }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_3',
          toolName: 'Read',
          args: { path: '/workspace/src/other.ts' },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });


  it('caches session approvals for tools without argument matchers at tool granularity', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));
    manager.setMode('ask');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_custom_1',
          toolName: 'Custom',
          args: { query: 'first' },
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_custom_2',
          toolName: 'Custom',
          args: { query: 'second' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(manager.sessionApprovalRulePatterns).toContain('Custom');
  });

  it('keeps approved once responses one-shot', async () => {
    const { manager, record, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('ask');
    manager.rules.push({ decision: 'ask', scope: 'user', pattern: 'Read(/workspace/**)' });
    const read = (id: string) => hookContext({ id, toolName: 'Read', args: { path: '/workspace/src/app.ts' } });

    await expect(manager.beforeToolCall(read('call_1'))).resolves.toBeUndefined();
    await expect(manager.beforeToolCall(read('call_2'))).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(2);
    const approvalRecords = record.mock.calls
      .map(([entry]) => entry as { type: string })
      .filter((entry) => entry.type === 'permission.record_approval_result');
    expect(approvalRecords).toHaveLength(2);
    expect(approvalRecords[0]).toEqual({
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_1',
      toolName: 'Read',
      action: 'read file',
      sessionApprovalRule: undefined,
      result: {
        decision: 'approved',
      },
    });
    expect(approvalRecords[1]).toEqual({
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_2',
      toolName: 'Read',
      action: 'read file',
      sessionApprovalRule: undefined,
      result: {
        decision: 'approved',
      },
    });
    expect(manager.data().rules.filter((rule) => rule.scope === 'session-runtime')).toEqual([]);
  });

  it('does not let session approval override an explicit deny rule', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_session',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(printf first)',
      result: {
        decision: 'approved',
        scope: 'session',
      },
    });
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'blocked by test',
    });

    const result = await manager.beforeToolCall(hookContext({ id: 'call_1' }));

    expect(result).toMatchObject({
      block: true,
      reason: 'Tool "Bash" was denied by permission rule. Reason: blocked by test',
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('continues across non-matching and malformed session approval patterns', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_bad_session',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(unterminated',
      result: { decision: 'approved', scope: 'session' },
    });
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_other_session',
      toolName: 'Custom',
      action: 'call custom',
      sessionApprovalRule: 'Custom',
      result: { decision: 'approved', scope: 'session' },
    });
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_matching_session',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(printf first)',
      result: { decision: 'approved', scope: 'session' },
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_session_match_late' }))).resolves
      .toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });

  it('replays session approval wire events into agent permission state', () => {
    const ctx = testAgent();
    const sessionApprovalRule = 'Bash(printf first)';

    ctx.dispatch({
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_replay',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule,
      result: {
        decision: 'approved',
        scope: 'session',
        selectedLabel: 'Approve for this session',
      },
    });

    expect(ctx.agent.permission.data().rules).toEqual([]);
    expect(ctx.agent.permission.sessionApprovalRulePatterns).toContain(sessionApprovalRule);
  });

  it('replays one-shot approval wire events without adding session rules', () => {
    const ctx = testAgent();
    const record = {
      turnId: 0,
      toolCallId: 'call_replay',
      toolName: 'Bash',
      action: 'run command',
      result: {
        decision: 'approved',
        selectedLabel: 'Approve once',
      },
    } as const;

    const event = {
      type: 'permission.record_approval_result',
      ...record,
    } as const;

    ctx.dispatch(event);

    expect(ctx.agent.replayBuilder.buildResult()).toContainEqual({
      type: 'approval_result',
      record: event,
    });
    expect(ctx.agent.permission.data().rules).toEqual([]);
  });
});

describe('Approval cancellation', () => {
  it('blocks when approval request is cancelled', async () => {
    const { manager } = makePermissionManager(async () => ({
      decision: 'cancelled',
      feedback: 'request closed',
    }));
    // ask mode + a user ask rule on a read path: the surviving prompt path.
    manager.setMode('ask');
    manager.rules.push({ decision: 'ask', scope: 'user', pattern: 'Read' });

    await expect(
      manager.beforeToolCall(
        hookContext({ id: 'call_1', toolName: 'Read', args: { path: '/workspace/notes.md' } }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('approval request was cancelled'),
    });
  });

  it('fails closed for fallback ask when no approval handler is available', async () => {
    const { manager, record } = makePermissionManager(async () => ({ decision: 'approved' }), {
      approvalHandlerAvailable: false,
    });
    // Custom is outside the default-approve catalog and not a mutating tool the
    // ask guard denies, so it reaches fallback-ask.
    manager.setMode('ask');

    await expect(
      manager.beforeToolCall(
        hookContext({ id: 'call_no_handler', toolName: 'Custom', args: { value: 1 } }),
      ),
    ).resolves.toEqual({
      block: true,
      reason:
        'Tool "Custom" was not run because the approval request was cancelled. Reason: Approval handler is unavailable.',
    });
    expect(record).toHaveBeenCalledWith({
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_no_handler',
      toolName: 'Custom',
      action: 'call Custom',
      sessionApprovalRule: undefined,
      result: {
        decision: 'cancelled',
        feedback: 'Approval handler is unavailable.',
      },
    });
  });

  it('fails closed for a user ask rule when no approval handler is available', async () => {
    const { manager, record } = makePermissionManager(async () => ({ decision: 'approved' }), {
      approvalHandlerAvailable: false,
    });
    manager.setMode('ask');
    manager.rules.push({ decision: 'ask', scope: 'user', pattern: 'Read' });

    await expect(
      manager.beforeToolCall(
        hookContext({ id: 'call_no_handler', toolName: 'Read', args: { path: '/workspace/notes.md' } }),
      ),
    ).resolves.toEqual({
      block: true,
      reason:
        'Tool "Read" was not run because the approval request was cancelled. Reason: Approval handler is unavailable.',
    });
    expect(record).toHaveBeenCalledWith({
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_no_handler',
      toolName: 'Read',
      action: 'read file',
      sessionApprovalRule: undefined,
      result: {
        decision: 'cancelled',
        feedback: 'Approval handler is unavailable.',
      },
    });
  });

  it.each(['auto', 'yolo'] as const)(
    'keeps %s pre-approval independent of an approval handler',
    async (mode) => {
      const { manager, record } = makePermissionManager(async () => ({ decision: 'rejected' }), {
        approvalHandlerAvailable: false,
      });
      manager.mode = mode;

      await expect(manager.beforeToolCall(hookContext({ id: `call_${mode}` }))).resolves.toBeUndefined();
      expect(record).not.toHaveBeenCalled();
    },
  );

  it('keeps WolfPack spawn pre-approval independent of an approval handler', async () => {
    const { manager, record } = makePermissionManager(async () => ({ decision: 'rejected' }), {
      approvalHandlerAvailable: false,
      wolfpackModeActive: true,
    });

    await expect(
      manager.beforeToolCall(
        hookContext({ id: 'call_wolfpack', toolName: 'WolfPack', args: { items: [] } }),
      ),
    ).resolves.toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });
});

describe('Default git CWD Write/Edit permission', () => {
  const DIR_MODE = 0o040_755;
  const FILE_MODE = 0o100_644;
  const SYMLINK_MODE = 0o120_777;

  function statResult(mode: number): Awaited<ReturnType<Jian['stat']>> {
    return {
      stMode: mode,
      stIno: 1,
      stDev: 1,
      stNlink: 1,
      stUid: 1000,
      stGid: 1000,
      stSize: 0,
      stAtime: 0,
      stMtime: 0,
      stCtime: 0,
    };
  }

  function notFound(path: string): Error {
    return Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
  }

  function sshNotFound(path: string): Error {
    const error = Object.assign(new Error(`No such file: ${path}`), { code: 2 });
    error.name = 'JianFileNotFoundError';
    return error;
  }

  function gitJian(options: {
    readonly markerPath?: string | undefined;
    readonly markerMode?: number | undefined;
    readonly statModes?: Readonly<Record<string, number>> | undefined;
    readonly readText?: Jian['readText'] | undefined;
    readonly missingError?: (path: string) => Error;
  } = {}): { jian: Jian; stat: ReturnType<typeof vi.fn<Jian['stat']>> } {
    const markerPath = options.markerPath ?? '/workspace/.git';
    const statModes: Readonly<Record<string, number>> = {
      '/workspace': DIR_MODE,
      '/workspace/src': DIR_MODE,
      [markerPath]: options.markerMode ?? DIR_MODE,
      ...options.statModes,
    };
    const stat = vi
      .fn<Jian['stat']>()
      .mockImplementation(async (path) => {
        const mode = statModes[path];
        if (mode !== undefined) return statResult(mode);
        throw options.missingError?.(path) ?? notFound(path);
      });
    return {
      jian: createFakeJian({ stat, readText: options.readText }),
      stat,
    };
  }

  function nonGitJian(): Jian {
    return createFakeJian({
      stat: vi.fn<Jian['stat']>().mockRejectedValue(new Error('ENOENT')),
    });
  }

  function writeHook(args: Record<string, unknown>, id = 'call_write'): PermissionPolicyContext {
    return hookContext({ id, toolName: 'Write', args });
  }

  function editHook(args: Record<string, unknown>, id = 'call_edit'): PermissionPolicyContext {
    return hookContext({ id, toolName: 'Edit', args });
  }


  it('bypasses approval for Write to a relative path inside a git cwd', async () => {
    const { jian } = gitJian();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { jian },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });

  it('bypasses approval for Edit on an absolute path inside the git cwd', async () => {
    const { jian } = gitJian();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { jian },
    );

    await expect(
      manager.beforeToolCall(
        editHook({ path: '/workspace/src/a.ts', old_string: 'A', new_string: 'B' }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });








  it('does not ask for ordinary file access when a git marker exists', async () => {
    const { jian } = gitJian();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { jian },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_read_regular_git_cwd',
          toolName: 'Read',
          args: { path: '/workspace/src/a.ts' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });


  it('asks before accessing the .git marker path itself', async () => {
    const { jian } = gitJian();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { jian },
    );
    // ask mode lets Read through the read-only guard, so the git-control-path
    // ask below it still fires.
    manager.setMode('ask');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_read_git_marker',
          toolName: 'Read',
          args: { path: '/workspace/.git' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('detects Win32 .git path components case-insensitively', async () => {
    const jian = createFakeJian({ pathClass: () => 'win32' });
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cwd: 'C:\\repo', jian },
    );
    manager.setMode('ask');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_win_git_control',
          toolName: 'Read',
          args: { path: 'C:\\repo\\.GIT\\config' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('does not check git control paths when cwd is empty', async () => {
    const { jian } = gitJian();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cwd: '', jian },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_empty_cwd_git',
          toolName: 'Read',
          args: { path: '/workspace/.git/config' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });


  it.each([
    [
      'Read',
      { path: '/workspace/src/a.ts' },
      { path: '/workspace/.gitdir/config' },
    ],
    [
      'Grep',
      { pattern: 'TODO', path: '/workspace/src' },
      { pattern: 'TODO', path: '/workspace/.gitdir' },
    ],
    [
      'Glob',
      { pattern: '**/*.ts', path: '/workspace/src' },
      { pattern: '*', path: '/workspace/.gitdir' },
    ],
  ] as const)(
    'rechecks git marker changes before default-approving %s access',
    async (toolName, firstArgs, secondArgs) => {
      let markerReady = false;
      const stat = vi.fn<Jian['stat']>(async (path) => {
        if (markerReady && path === '/workspace/.git') return statResult(FILE_MODE);
        throw notFound(path);
      });
      const readText = vi.fn<Jian['readText']>(async (path) => {
        if (path === '/workspace/.git') return 'gitdir: .gitdir\n';
        throw notFound(path);
      });
      const { manager, requestApproval } = makePermissionManager(
        async () => ({ decision: 'approved' }),
        { jian: createFakeJian({ stat, readText }) },
      );
      // ask mode: reads survive the guard, and the git-marker recheck decides
      // whether the sensitive-path ask fires below default approval.
      manager.setMode('ask');

      await expect(
        manager.beforeToolCall(hookContext({ id: `call_${toolName}_before`, toolName, args: firstArgs })),
      ).resolves.toBeUndefined();
      expect(requestApproval).not.toHaveBeenCalled();

      markerReady = true;
      await expect(
        manager.beforeToolCall(hookContext({ id: `call_${toolName}_after`, toolName, args: secondArgs })),
      ).resolves.toBeUndefined();

      expect(requestApproval).toHaveBeenCalledTimes(1);
    },
  );

  it('bypasses approval for a lexical path inside git cwd without resolving parent symlinks', async () => {
    const { jian } = gitJian({
      statModes: { '/workspace/out': SYMLINK_MODE },
    });
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { jian },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'out/hosts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });

  it('bypasses approval for a lexical target inside git cwd without resolving target symlinks', async () => {
    const { jian } = gitJian({
      statModes: { '/workspace/link.txt': SYMLINK_MODE },
    });
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { jian },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'link.txt', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });



  it('detects sensitive Win32 paths case-insensitively', async () => {
    const jian = createFakeJian({ pathClass: () => 'win32' });
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cwd: 'C:\\repo', jian },
    );
    manager.setMode('ask');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_win_credentials',
          toolName: 'Read',
          args: { path: 'C:\\repo\\.AWS\\Credentials' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    
  });

  it('requests approval for sensitive read access before default approval', async () => {
    const { jian } = gitJian();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { jian },
    );
    manager.setMode('ask');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_read_env',
          toolName: 'Read',
          args: { path: '.env' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('bypasses approval for new files when SSH Jian reports numeric no-such-file', async () => {
    const { jian } = gitJian({ missingError: sshNotFound });
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { jian },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/new.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });


  it('lets an explicit `allow` rule take the original allow path without git cwd approval', async () => {
    const { jian } = gitJian();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { jian },
    );
    manager.rules.push({
      decision: 'allow',
      scope: 'user',
      pattern: 'Write',
    });

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });

  it('keeps explicit `deny` rules higher priority than the bypass', async () => {
    const { jian } = gitJian();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { jian },
    );
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Write',
      reason: 'no writes here',
    });

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('no writes here'),
    });

    expect(requestApproval).not.toHaveBeenCalled();
    
  });

  it('does not fire in auto mode because auto-mode-approve takes over', async () => {
    const { jian } = gitJian();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { jian },
    );
    manager.setMode('auto');

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
    
  });




  it('approves multiple write accesses when all are inside the git cwd', async () => {
    const { jian } = gitJian();
    const args = { path: 'src/a.ts', content: 'x' };
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { jian },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_multi_inside_write',
          toolName: 'Write',
          args,
          execution: {
            ...testExecution('Write', args),
            accesses: [
              { kind: 'file', operation: 'write', path: '/workspace/src/a.ts' },
              { kind: 'file', operation: 'readwrite', path: '/workspace/src/b.ts' },
            ],
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });



});

describe('CWD outside file write permission policy', () => {
  it.each([
    ['Read', { path: '/tmp/outside.ts' }],
    ['Grep', { pattern: 'TODO', path: '/tmp' }],
  ] as const)('does not ask for %s access outside cwd', async (toolName, args) => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: `call_${toolName}_outside_cwd`,
          toolName,
          args,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    
  });

  it('uses Win32 path semantics for cwd containment', async () => {
    const jian = createFakeJian({ pathClass: () => 'win32' });
    const args = { path: 'c:\\repo\\src\\a.ts', content: 'x' };
    const { manager } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cwd: 'C:\\Repo', jian },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_win_inside_cwd',
          toolName: 'Write',
          args,
          execution: {
            ...testExecution('Write', args),
            accesses: ToolAccesses.writeFile('c:\\repo\\src\\a.ts'),
          },
        }),
      ),
    ).resolves.toBeUndefined();

    
  });
});

describe('Permission rule helpers', () => {
  it('parses permission patterns used by rule matching', () => {
    expect(parsePattern('Write')).toEqual({ toolName: 'Write' });
    expect(parsePattern('Read(/etc/**)')).toEqual({
      toolName: 'Read',
      argPattern: '/etc/**',
    });
    expect(parsePattern('Edit(!./src/**)')).toEqual({
      toolName: 'Edit',
      argPattern: '!./src/**',
    });
    expect(parsePattern('  mcp__github__*  ')).toEqual({ toolName: 'mcp__github__*' });
    expect(parsePattern('Read()')).toEqual({ toolName: 'Read' });
    expect(() => parsePattern('Read(/etc/**')).toThrow(/missing closing paren/);
    expect(() => parsePattern('')).toThrow(/empty string/);
  });

  it('matches rules against the tool-specific argument fields', () => {
    expect(
      ruleMatches(permissionRule('Bash(git *)'), 'Bash', { command: 'git status' }, {
        matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, 'git status'),
      }),
    ).toBe(true);
    expect(
      ruleMatches(permissionRule('Bash(git *)'), 'Bash', { command: 'npm test' }, {
        matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, 'npm test'),
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Read(/etc/**)'), 'Read', { path: '/etc/passwd' }, {
        matchesRule: (ruleArgs) => matchesPathRuleSubject(ruleArgs, '/etc/passwd'),
      }),
    ).toBe(true);
    expect(
      ruleMatches(permissionRule('Edit(!./src/**)'), 'Edit', { path: './README.md' }, {
        matchesRule: (ruleArgs) =>
          matchesPathRuleSubject(ruleArgs, '/workspace/README.md', {
            cwd: '/workspace',
            pathClass: 'posix',
          }),
      }),
    ).toBe(true);
    expect(
      ruleMatches(permissionRule('Edit(!./src/**)'), 'Edit', { path: './src/a.ts' }, {
        matchesRule: (ruleArgs) =>
          matchesPathRuleSubject(ruleArgs, '/workspace/src/a.ts', {
            cwd: '/workspace',
            pathClass: 'posix',
          }),
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Agent(review-*)'), 'Agent', {
        subagent_type: 'review-code',
      }, {
        matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, 'review-code'),
      }),
    ).toBe(true);
    expect(ruleMatches(permissionRule('mcp__github__*'), 'mcp__github__list_issues', {})).toBe(
      true,
    );
    expect(
      ruleMatches(permissionRule('Bash(git *)'), 'Bash', { command: 42 }, {
        matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, '42'),
      }),
    ).toBe(false);
    expect(ruleMatches(permissionRule('Bad(unclosed'), 'Bad', {})).toBe(false);
  });

  it('does not match rule arguments without an execution matcher', () => {
    expect(
      ruleMatches(permissionRule('Custom("query":"a.b")'), 'Custom', {
        nested: { value: 1 },
        query: 'a.b',
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Bash("command":"git status")'), 'Bash', {
        command: 'git status',
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Bash(^git status$)'), 'Bash', {
        command: 'git status',
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Bash(^git status$)'), 'Bash', {
        command: 'npm test',
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Read([invalid'), 'Read', {
        path: '/workspace/a.ts',
      }),
    ).toBe(false);
  });

  it('treats empty arg patterns as tool-name-only matches', () => {
    expect(ruleMatches(permissionRule('Read()'), 'Read', { path: '/workspace/a.ts' })).toBe(true);
    expect(ruleMatches(permissionRule('Custom()'), 'Custom', { anything: 1 })).toBe(true);
    expect(ruleMatches(permissionRule('Read()'), 'Write', { path: '/workspace/a.ts' })).toBe(false);
  });

  it('matches paths case-insensitively so case-only variants cannot bypass rules', () => {
    expect(
      ruleMatches(permissionRule('Edit(/repo/secrets.env)'), 'Edit', { path: '/repo/Secrets.env' }, {
        matchesRule: (ruleArgs) =>
          matchesPathRuleSubject(ruleArgs, '/repo/Secrets.env', {
            cwd: '/repo',
            pathClass: 'posix',
          }),
      }),
    ).toBe(true);
    expect(
      ruleMatches(permissionRule('Edit(/repo/Sub/**)'), 'Edit', { path: '/repo/sub/a.ts' }, {
        matchesRule: (ruleArgs) =>
          matchesPathRuleSubject(ruleArgs, '/repo/sub/a.ts', {
            cwd: '/repo',
            pathClass: 'posix',
          }),
      }),
    ).toBe(true);
  });

  it('delegates rule argument semantics to execution.matchesRule when available', () => {
    const execution = {
      matchesRule: vi.fn((ruleArgs: string) => ruleArgs === 'semantic match'),
    };

    expect(
      ruleMatches(permissionRule('Read(semantic match)'), 'Read', { path: '/workspace/a.ts' }, execution),
    ).toBe(true);
    expect(execution.matchesRule).toHaveBeenCalledWith('semantic match');
    expect(
      ruleMatches(permissionRule('Read(other)'), 'Read', { path: '/workspace/a.ts' }, execution),
    ).toBe(false);
  });

});

function bashCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
    arguments: '{"command":"printf permission-output","timeout":60}',
  };
}

describe('Approval timeout timer', () => {
  it('clears the rejection timer once the approval response arrives first', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const { manager } = makePermissionManager(async () => ({ decision: 'approved' }));
      manager.setMode('ask');
      manager.rules.push({ decision: 'ask', scope: 'user', pattern: 'Read' });

      await expect(
        manager.beforeToolCall(
          hookContext({ id: 'call_timeout_clear', toolName: 'Read', args: { path: '/workspace/notes.md' } }),
        ),
      ).resolves.toBeUndefined();

      // The race settled via the response; the 5-minute rejection timer must
      // not linger (it used to leak one live timer per approval).
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      clearSpy.mockRestore();
    }
  });

  it('surfaces the timeout message when no response ever arrives', async () => {
    vi.useFakeTimers();
    try {
      const { manager, requestApproval } = makePermissionManager(
        () => new Promise<ApprovalResponse>(() => {}),
      );
      manager.setMode('ask');
      manager.rules.push({ decision: 'ask', scope: 'user', pattern: 'Read' });

      const pending = manager.beforeToolCall(
        hookContext({ id: 'call_timeout_fire', toolName: 'Read', args: { path: '/workspace/notes.md' } }),
      );
      const assertion = expect(pending).rejects.toThrow('Approval request timed out after 300000ms');
      await vi.advanceTimersByTimeAsync(300_000);
      await assertion;
      expect(requestApproval).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

function makePermissionManager(
  handleApproval: (request: unknown) => Promise<ApprovalResponse>,
  options: {
    readonly parent?: PermissionManager | undefined;
    readonly planModeActive?: boolean;
    readonly planFilePath?: string | null | undefined;
    readonly jian?: Jian;
    readonly cwd?: string;
    readonly agentType?: Agent['type'];
    readonly hooks?: Agent['hooks'];
    readonly approvalHandlerAvailable?: boolean;
    readonly wolfpackModeActive?: boolean;
    readonly promptSummary?: string;
    readonly initialRules?: readonly PermissionRule[];
    readonly mode?: PermissionMode;
  } = {},
): {
  manager: PermissionManager;
  record: ReturnType<typeof vi.fn>;
  requestApproval: ReturnType<typeof vi.fn>;
} {
  let manager!: PermissionManager;
  const requestApproval = vi.fn(handleApproval);
  const record = vi.fn();
  const agent = {
    type: options.agentType ?? 'main',
    config: { cwd: options.cwd ?? '/workspace' },
    jian: options.jian ?? createFakeJian(),
    emitStatusUpdated: vi.fn(),
    records: { logRecord: record },
    replayBuilder: { push: vi.fn() },
    rpc: options.approvalHandlerAvailable === false ? {} : { requestApproval },
    // The approval payload reads the turn's prompt summary.
    turn: { getLastPromptSummary: () => options.promptSummary },
    hooks: options.hooks,
    wolfpackMode: { isActive: options.wolfpackModeActive ?? false },
    getCapabilityMode: () => 'all' as const,
    planMode: {
      get isActive() {
        return options.planModeActive ?? false;
      },
      get planFilePath() {
        return options.planFilePath ?? null;
      },
      data: vi.fn(async () => null),
      exit: vi.fn(),
    },
  } as unknown as Agent;
  manager = new PermissionManager(agent, options);
  Object.assign(agent, { permission: manager });
  return { manager, record, requestApproval };
}

function makePlanPermissionManager(input: {
  readonly mode: PermissionMode;
  readonly plan?: string | null | undefined;
  readonly path?: string | undefined;
  readonly approval?: ApprovalResponse | undefined;
  readonly approvalError?: Error | undefined;
  readonly approvalHandlerAvailable?: boolean;
}): {
  manager: PermissionManager;
  record: ReturnType<typeof vi.fn>;
  requestApproval: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
} {
  const requestApproval = vi.fn(async () => {
    if (input.approvalError !== undefined) throw input.approvalError;
    return input.approval ?? { decision: 'approved' };
  });
  const record = vi.fn();
  const exit = vi.fn();
  const path = input.path ?? '/tmp/plan.md';
  const agent = {
    type: 'main',
    agentId: 'main',
    config: { cwd: '/workspace' },
    jian: createFakeJian(),
    emitStatusUpdated: vi.fn(),
    records: { logRecord: record },
    replayBuilder: { push: vi.fn() },
    rpc: input.approvalHandlerAvailable === false ? {} : { requestApproval },
    // The approval payload reads the turn's prompt summary.
    turn: { getLastPromptSummary: () => undefined },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    getCapabilityMode: () => 'all' as const,
    planMode: {
      get isActive() {
        return true;
      },
      get planFilePath() {
        return path;
      },
      data: vi.fn(async () => {
        if (input.plan === null) return null;
        return {
          content: input.plan ?? '# Plan',
          path,
        };
      }),
      exit,
    },
  } as unknown as Agent;
  const manager = new PermissionManager(agent);
  Object.assign(agent, { permission: manager });
  manager.mode = input.mode;
  return { manager, record, requestApproval, exit };
}

function hookContext(input: {
  readonly id: string;
  readonly toolName?: string | undefined;
  readonly args?: Record<string, unknown> | undefined;
  readonly execution?: PermissionPolicyContext['execution'] | undefined;
}): PermissionPolicyContext {
  const toolName = input.toolName ?? 'Bash';
  const args = input.args ?? { command: 'printf first', timeout: 60 };
  const toolCall: ToolCall = {
    type: 'function',
    id: input.id,
    name: toolName,
      arguments: JSON.stringify(args),
  };
  return {
    turnId: '0',
    stepNumber: 1,
    signal: new AbortController().signal,
    llm: {} as PermissionPolicyContext['llm'],
    toolCall,
    args,
    execution: input.execution ?? testExecution(toolName, args),
  };
}

function permissionRule(
  pattern: string,
  decision: PermissionRule['decision'] = 'allow',
): PermissionRule {
  return {
    decision,
    scope: 'turn-override',
    pattern,
  };
}

function ruleMatches(
  rule: PermissionRule,
  toolName: string,
  args: unknown,
  execution: PermissionRuleMatchExecution = {},
): boolean {
  void args;
  return matchPermissionRule({ rule, toolName, execution }) !== undefined;
}

function genericDisplay(): ToolInputDisplay {
  return { kind: 'generic', summary: 'Approve tool', detail: {} };
}

function planReviewExecution(input: {
  readonly plan: string;
  readonly path?: string | undefined;
  readonly options?: readonly { readonly label: string; readonly description: string }[] | undefined;
}): PermissionPolicyContext['execution'] {
  return {
    description: 'Presenting plan and exiting plan mode',
    display: {
      kind: 'plan_review',
      plan: input.plan,
      path: input.path,
      options: input.options,
    },
    accesses: ToolAccesses.none(),
    approvalRule: 'ExitPlanMode',
    execute: async () => ({ output: '' }),
  };
}

function testExecution(
  toolName: string,
  args: Record<string, unknown>,
): PermissionPolicyContext['execution'] {
  const ruleSubject = testRuleSubject(toolName, args);
  return {
    description: testDescription(toolName, args),
    display: testDisplay(toolName, args),
    accesses: testAccesses(toolName, args),
    approvalRule: ruleSubject === undefined ? toolName : literalRulePattern(toolName, ruleSubject),
    matchesRule:
      ruleSubject === undefined
        ? undefined
        : (ruleArgs) => testMatchesRuleSubject(toolName, ruleArgs, ruleSubject),
    execute: async () => ({ output: '' }),
  };
}

function testRuleSubject(toolName: string, args: Record<string, unknown>): string | undefined {
  switch (toolName) {
    case 'Bash':
      return stringArg(args, 'command');
    case 'Read':
    case 'ReadMediaFile':
    case 'Write':
    case 'Edit':
      return canonicalTestPath(stringArg(args, 'path', '/workspace/file.txt'));
    case 'Grep':
    case 'Glob':
      return stringArg(args, 'pattern');
    default:
      return undefined;
  }
}

function testMatchesRuleSubject(
  toolName: string,
  ruleArgs: string,
  ruleSubject: string,
): boolean {
  switch (toolName) {
    case 'Read':
    case 'ReadMediaFile':
    case 'Write':
    case 'Edit':
      return matchesPathRuleSubject(ruleArgs, ruleSubject);
    default:
      return matchesGlobRuleSubject(ruleArgs, ruleSubject);
  }
}

function testDescription(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return 'run command';
    case 'ExitPlanMode':
      return 'review plan';
    case 'Read':
      return 'read file';
    case 'ReadMediaFile':
      return 'read media file';
    case 'Write':
      return 'write file';
    case 'Edit':
      return 'edit file';
    case 'Grep':
      return `Searching for '${stringArg(args, 'pattern')}' in ${stringArg(args, 'path', '/workspace')}`;
    case 'Glob':
      return `Searching ${stringArg(args, 'pattern')}`;
    default:
      return `call ${toolName}`;
  }
}

function stringArg(args: Record<string, unknown>, key: string, fallback = ''): string {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

function testDisplay(toolName: string, args: Record<string, unknown>): ToolInputDisplay {
  const path = typeof args['path'] === 'string' ? args['path'] : '/workspace/file.txt';
  switch (toolName) {
    case 'Bash':
      return {
        kind: 'command',
        command: typeof args['command'] === 'string' ? args['command'] : '',
      };
    case 'Read':
    case 'ReadMediaFile':
      return { kind: 'file_io', operation: 'read', path };
    case 'Write':
      return { kind: 'file_io', operation: 'write', path };
    case 'Edit':
      return { kind: 'file_io', operation: 'edit', path };
    case 'Grep':
      return { kind: 'file_io', operation: 'grep', path };
    case 'Glob':
      return { kind: 'file_io', operation: 'glob', path };
    default:
      return genericDisplay();
  }
}

function testAccesses(toolName: string, args: Record<string, unknown>) {
  const path = typeof args['path'] === 'string' ? canonicalTestPath(args['path']) : undefined;
  if (toolName === 'Read' && path !== undefined) return ToolAccesses.readFile(path);
  if (toolName === 'ReadMediaFile' && path !== undefined) return ToolAccesses.readFile(path);
  if (toolName === 'Write' && path !== undefined) return ToolAccesses.writeFile(path);
  if (toolName === 'Edit' && path !== undefined) return ToolAccesses.readWriteFile(path);
  if ((toolName === 'Grep' || toolName === 'Glob') && path !== undefined) {
    return ToolAccesses.searchTree(path);
  }
  return ToolAccesses.none();
}

function canonicalTestPath(path: string): string {
  return posixPath.isAbsolute(path) ? posixPath.normalize(path) : posixPath.resolve('/workspace', path);
}

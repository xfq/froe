import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActionRuntime, type ApprovalGate, type ApprovalRequest } from "../src/action-runtime.js";
import { CommandSandboxError, type CommandInvocation, type CommandSandbox, type SandboxedCommandResult, type SandboxException } from "../src/command-sandbox.js";
import { runConversation } from "../src/conversation.js";
import { defaultConfig } from "../src/config.js";
import type { McpManager } from "../src/mcp.js";
import { ScriptedModel } from "../src/scripted-model.js";
import type { RunEvent } from "../src/types.js";
import type { TerminalMessage } from "../src/terminal-conversation.js";

class Approval implements ApprovalGate {
  async request(_request: ApprovalRequest): Promise<boolean> {
    return true;
  }
}

class NoCommands implements CommandSandbox {
  async run(_command: CommandInvocation, _exceptions: SandboxException[] = []): Promise<SandboxedCommandResult> {
    throw new CommandSandboxError("command_start_failed", "No command expected in this test");
  }
}

test("a conversation sends follow-up messages after a completed run", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-conversation-"));
  const runtime = await ActionRuntime.create(root, defaultConfig, new Approval(), new NoCommands());
  const image = { data: Uint8Array.of(1, 2, 3), mediaType: "image/png" as const };
  const model = new ScriptedModel([
    (turn) => {
      assert.deepEqual(turn.images, [image]);
      return [finishAction("first-finish", "Handled the first message.")];
    },
    (turn) => {
      assert.equal(turn.user, "Please add tests too");
      assert.equal(turn.images, undefined);
      assert.equal(turn.actionResults?.[0]?.callId, "first-finish");
      assert.equal(turn.actionResults?.[0]?.name, "finish");
      return [finishAction("second-finish", "Handled the follow-up message.")];
    },
  ]);
  const events: RunEvent[] = [];

  const outcomes = await runConversation({
    messages: messages("Implement the feature", "Please add tests too"),
    images: [image],
    model,
    runtime,
    instructions: [],
    modelName: "scripted",
    maxTurns: 2,
    selectModel: () => {},
    emit: (event) => {
      events.push(event);
    },
  });

  assert.deepEqual(outcomes.map((outcome) => outcome.summary), [
    "Handled the first message.",
    "Handled the follow-up message.",
  ]);
  assert.equal(events.filter((event) => event.type === "run_started").length, 2);
  assert.equal(events.filter((event) => event.type === "run_finished").length, 2);
});

test("a conversation changes models between runs without treating the command as a task", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-conversation-"));
  const runtime = await ActionRuntime.create(root, defaultConfig, new Approval(), new NoCommands());
  const model = new ScriptedModel([
    () => [finishAction("first-finish", "Handled the first message.")],
    () => [finishAction("second-finish", "Handled the second message.")],
  ]);
  const selected: string[] = [];
  const events: RunEvent[] = [];

  await runConversation({
    messages: messages(
      "First task",
      { type: "model", model: "gpt-5.6-sol" },
      "Second task",
    ),
    images: [],
    model,
    runtime,
    instructions: [],
    modelName: "gpt-5.6-terra",
    maxTurns: 2,
    selectModel: (modelName) => {
      selected.push(modelName);
    },
    emit: (event) => {
      events.push(event);
    },
  });

  assert.deepEqual(selected, ["gpt-5.6-sol"]);
  assert.deepEqual(events.filter((event) => event.type === "run_started").map((event) => event.model), [
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ]);
});

test("a conversation reports MCP status without starting a run", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-conversation-"));
  const runtime = await ActionRuntime.create(root, defaultConfig, new Approval(), new NoCommands());
  let reports = 0;

  const outcomes = await runConversation({
    messages: messages({ type: "mcp" }),
    images: [],
    model: new ScriptedModel([]),
    runtime,
    instructions: [],
    modelName: "scripted",
    maxTurns: 2,
    selectModel: () => {},
    showMcpServers: () => {
      reports += 1;
    },
  });

  assert.deepEqual(outcomes, []);
  assert.equal(reports, 1);
});

test("a conversation makes active MCP tools available to its runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-conversation-"));
  const runtime = await ActionRuntime.create(root, defaultConfig, new Approval(), new NoCommands());
  const mcp = {
    tools: [{
      name: "mcp__docs__lookup",
      description: "Look up documentation.",
      parameters: { type: "object" },
    }],
    hasTool: (name: string) => name === "mcp__docs__lookup",
    execute: async () => ({
      callId: "lookup",
      name: "mcp__docs__lookup",
      ok: true,
      output: { content: [{ type: "text", text: "MCP documentation" }] },
    }),
  } as unknown as McpManager;
  const model = new ScriptedModel([
    (turn) => {
      assert.equal(turn.tools.some((tool) => tool.name === "mcp__docs__lookup"), true);
      return [{
        type: "action",
        action: { callId: "lookup", name: "mcp__docs__lookup", arguments: {} },
      }];
    },
    (turn) => {
      assert.deepEqual(turn.actionResults?.[0], {
        callId: "lookup",
        name: "mcp__docs__lookup",
        ok: true,
        output: { content: [{ type: "text", text: "MCP documentation" }] },
      });
      return [finishAction("finish", "Used MCP documentation.")];
    },
  ]);

  const outcomes = await runConversation({
    messages: messages("Look up MCP documentation"),
    images: [],
    model,
    runtime,
    mcp,
    instructions: [],
    modelName: "scripted",
    maxTurns: 2,
    selectModel: () => {},
  });

  assert.equal(outcomes[0]?.status, "completed");
});

async function* messages(...values: Array<string | TerminalMessage>): AsyncGenerator<TerminalMessage> {
  for (const value of values) yield typeof value === "string" ? { type: "task", text: value } : value;
}

function finishAction(callId: string, summary: string) {
  return {
    type: "action" as const,
    action: {
      callId,
      name: "finish",
      arguments: {
        outcome: "completed",
        summary,
        verification: [{ description: "Test fixture", result: "passed" }],
      },
    },
  };
}

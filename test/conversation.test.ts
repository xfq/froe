import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActionRuntime, type ApprovalGate, type ApprovalRequest } from "../src/action-runtime.js";
import { CommandSandboxError, type CommandInvocation, type CommandSandbox, type SandboxedCommandResult, type SandboxException } from "../src/command-sandbox.js";
import { runConversation } from "../src/conversation.js";
import { defaultConfig } from "../src/config.js";
import { ScriptedModel } from "../src/scripted-model.js";
import type { RunEvent } from "../src/types.js";

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
  const model = new ScriptedModel([
    [finishAction("first-finish", "Handled the first message.")],
    (turn) => {
      assert.equal(turn.user, "Please add tests too");
      assert.equal(turn.actionResults?.[0]?.callId, "first-finish");
      assert.equal(turn.actionResults?.[0]?.name, "finish");
      return [finishAction("second-finish", "Handled the follow-up message.")];
    },
  ]);
  const events: RunEvent[] = [];

  const outcomes = await runConversation({
    messages: messages("Implement the feature", "Please add tests too"),
    model,
    runtime,
    instructions: [],
    modelName: "scripted",
    maxTurns: 2,
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

async function* messages(...values: string[]): AsyncGenerator<string> {
  yield* values;
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

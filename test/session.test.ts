import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActionRuntime } from "../src/action-runtime.js";
import { CommandSandboxError, type CommandInvocation, type CommandSandbox, type SandboxedCommandResult, type SandboxException } from "../src/command-sandbox.js";
import { defaultConfig } from "../src/config.js";
import { McpManager } from "../src/mcp.js";
import { RunRecorder } from "../src/recorder.js";
import { ScriptedModel } from "../src/scripted-model.js";
import {
  createFroeSession,
  SessionApprovalGate,
  type FroeApprovalPrompt,
  type FroeSessionDependencies,
  type FroeSession,
  type FroeSessionAdapter,
  type FroeSessionEvent,
} from "../src/session.js";

class NoCommands implements CommandSandbox {
  async run(_command: CommandInvocation, _exceptions: SandboxException[] = []): Promise<SandboxedCommandResult> {
    throw new CommandSandboxError("command_start_failed", "No command expected in this test");
  }
}

test("a core session preserves continuation across sequential runs and emits ordered envelopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-session-"));
  const imagePath = join(root, "screenshot.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const events: FroeSessionEvent[] = [];
  const model = new ScriptedModel([
    (turn) => {
      assert.equal(turn.user, "First task");
      assert.equal(turn.images?.[0]?.mediaType, "image/png");
      return [finishAction("first", "First complete")];
    },
    (turn) => {
      assert.equal(turn.user, "Follow-up task");
      assert.equal(turn.images, undefined);
      assert.equal(turn.actionResults?.[0]?.callId, "first");
      return [finishAction("second", "Follow-up complete")];
    },
  ]);
  const session = await sessionFor(root, model, { onEvent: (event) => { events.push(event); } });

  const first = await session.run({ task: "First task", imagePaths: [imagePath] });
  const second = await session.run({ task: "Follow-up task" });

  assert.equal(first.summary, "First complete");
  assert.equal(second.summary, "Follow-up complete");
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.equal(new Set(events.map((event) => event.sessionId)).size, 1);
  assert.equal(new Set(events.map((event) => event.runId)).size, 2);
  assert.equal(events.filter((event) => event.event.type === "run_started").length, 2);
  assert.equal(events.filter((event) => event.event.type === "run_finished").length, 2);
  await session.close();
});

test("a core session owns destructive approval choices and publishes the request", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-session-"));
  const obsolete = join(root, "obsolete.txt");
  await writeFile(obsolete, "remove me");
  const events: FroeSessionEvent[] = [];
  const prompts: FroeApprovalPrompt[] = [];
  const model = new ScriptedModel([
    [{
      type: "action",
      action: {
        callId: "delete",
        name: "apply_patch",
        arguments: { changes: [{ path: "obsolete.txt", oldText: "remove me", newText: null }] },
      },
    }],
    [finishAction("finish", "Removed obsolete file")],
  ]);
  const adapter: FroeSessionAdapter = {
    onEvent: (event) => { events.push(event); },
    requestApproval: async (prompt) => {
      prompts.push(prompt);
      return "approve_once";
    },
  };
  const session = await sessionFor(root, model, adapter);

  const outcome = await session.run({ task: "Delete the obsolete file" });

  assert.equal(outcome.status, "completed");
  await assert.rejects(readFile(obsolete, "utf8"), /ENOENT/);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.destructive, true);
  assert.deepEqual(prompts[0]?.choices, ["approve_once", "deny"]);
  const approval = events.find((event) => event.event.type === "approval_requested");
  assert.ok(approval?.event.type === "approval_requested");
  assert.equal(approval.event.approvalId, prompts[0]?.id);
  assert.equal(approval.event.scope, "policy");
  await session.close();
});

test("a core session rejects concurrent runs at its interface", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-session-"));
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new ScriptedModel([
    async () => {
      await waiting;
      return [finishAction("finish", "Complete")];
    },
  ]);
  const session = await sessionFor(root, model);
  const first = session.run({ task: "First task" });

  assert.throws(
    () => session.run({ task: "Second task" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "session_busy",
  );
  release?.();
  await first;
  await session.close();
});

test("a core session resets model continuation and notifies the composition hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-session-"));
  const model = new ScriptedModel([
    (turn) => {
      assert.equal(turn.user, "First task");
      return [finishAction("first", "First complete")];
    },
    (turn) => {
      assert.equal(turn.user, "Second task");
      return [finishAction("second", "Second complete")];
    },
  ]);
  let hookCalls = 0;
  const session = await sessionFor(root, model, {}, {
    onConversationReset: () => {
      hookCalls += 1;
    },
  });

  const first = await session.run({ task: "First task" });
  assert.equal(first.summary, "First complete");
  assert.equal(hookCalls, 0);

  await session.resetConversation?.();
  assert.equal(hookCalls, 1);

  const replayed = await session.run({ task: "First task" });
  assert.equal(replayed.summary, "First complete");
  await session.close();
});

async function sessionFor(
  root: string,
  model: ScriptedModel,
  adapter: FroeSessionAdapter = {},
  dependencies: Partial<FroeSessionDependencies> = {},
): Promise<FroeSession> {
  const approval = new SessionApprovalGate("prompt", adapter);
  const runtime = await ActionRuntime.create(root, defaultConfig, approval, new NoCommands());
  const mcp = await McpManager.connect({});
  const recorder = await RunRecorder.create("metadata", true);
  return createFroeSession({
    config: structuredClone(defaultConfig),
    model,
    selectModel: () => undefined,
    runtime,
    mcp,
    instructions: [],
    recorder,
    approval,
    adapter,
    ...dependencies,
  });
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

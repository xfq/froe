import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActionRuntime, type ApprovalGate, type ApprovalRequest } from "../src/action-runtime.js";
import { CommandSandboxError, type CommandInvocation, type CommandSandbox, type SandboxedCommandResult, type SandboxException } from "../src/command-sandbox.js";
import { defaultConfig } from "../src/config.js";
import { runTask } from "../src/run.js";
import { ScriptedModel } from "../src/scripted-model.js";
import type { RunEvent } from "../src/types.js";

class Approval implements ApprovalGate {
  constructor(private readonly accepted: boolean) {}

  async request(_request: ApprovalRequest): Promise<boolean> {
    return this.accepted;
  }
}

class NoCommands implements CommandSandbox {
  async run(_command: CommandInvocation, _exceptions: SandboxException[] = []): Promise<SandboxedCommandResult> {
    throw new CommandSandboxError("command_start_failed", "No command expected in this test");
  }
}

async function runtime(root: string, accepted = true): Promise<ActionRuntime> {
  return ActionRuntime.create(root, defaultConfig, new Approval(accepted), new NoCommands());
}

test("a scripted model can patch, validate evidence, and complete a run", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-run-"));
  await writeFile(join(root, "greeting.ts"), "export const greeting = 'hi';\n");
  const model = new ScriptedModel([
    [{
      type: "action",
      action: {
        callId: "patch",
        name: "apply_patch",
        arguments: { changes: [{ path: "greeting.ts", oldText: "'hi'", newText: "'hello'" }] },
      },
    }],
    (turn) => {
      assert.equal(turn.actionResults?.[0]?.ok, true);
      return [{
        type: "action",
        action: {
          callId: "finish",
          name: "finish",
          arguments: {
            outcome: "completed",
            summary: "Updated the greeting.",
            verification: [{ description: "Reviewed the applied patch", result: "passed" }],
          },
        },
      }];
    },
  ]);
  const events: RunEvent[] = [];
  const outcome = await runTask({
    task: "Change the greeting",
    model,
    runtime: await runtime(root),
    instructions: [],
    modelName: "scripted",
    maxTurns: 4,
    emit: (event) => {
      events.push(event);
    },
  });

  assert.equal(outcome.status, "completed");
  assert.equal(await readFile(join(root, "greeting.ts"), "utf8"), "export const greeting = 'hello';\n");
  assert.equal(events.at(-1)?.type, "run_finished");
});

test("a run sends prompt images only with its first model turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-run-"));
  const image = { data: Uint8Array.of(1, 2, 3), mediaType: "image/png" as const };
  const model = new ScriptedModel([
    (turn) => {
      assert.deepEqual(turn.images, [image]);
      return [{
        type: "action",
        action: {
          callId: "read",
          name: "read_file",
          arguments: { path: "missing.txt" },
        },
      }];
    },
    (turn) => {
      assert.equal(turn.user, undefined);
      assert.equal(turn.images, undefined);
      return [{
        type: "action",
        action: {
          callId: "finish",
          name: "finish",
          arguments: {
            outcome: "completed",
            summary: "Checked the image.",
            verification: [{ description: "Test fixture", result: "passed" }],
          },
        },
      }];
    },
  ]);

  const outcome = await runTask({
    task: "Review the screenshot",
    images: [image],
    model,
    runtime: await runtime(root),
    instructions: [],
    modelName: "scripted",
    maxTurns: 2,
  });

  assert.equal(outcome.status, "completed");
});

test("a run emits context compaction metadata from the model provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-run-"));
  const model = new ScriptedModel([[
    { type: "context_compacted", previousItems: 120, retainedItems: 3, thresholdTokens: 200_000 },
    {
      type: "action",
      action: {
        callId: "finish",
        name: "finish",
        arguments: {
          outcome: "completed",
          summary: "Finished after compacting context.",
          verification: [{ description: "Test fixture", result: "passed" }],
        },
      },
    },
  ]]);
  const events: RunEvent[] = [];

  await runTask({
    task: "Complete a long task",
    model,
    runtime: await runtime(root),
    instructions: [],
    modelName: "scripted",
    maxTurns: 1,
    emit: (event) => {
      events.push(event);
    },
  });
  const compaction = events.find((event) => event.type === "context_compacted");

  assert.deepEqual(compaction, {
    type: "context_compacted",
    previousItems: 120,
    retainedItems: 3,
    thresholdTokens: 200_000,
  });
});

test("a run tells the model about additional authorized directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-run-"));
  const additionalDirectory = await realpath(await mkdtemp(join(tmpdir(), "froe-run-additional-")));
  const model = new ScriptedModel([(turn) => {
    assert.ok(turn.system.includes(`- ${additionalDirectory}`));
    return [{
      type: "action",
      action: {
        callId: "finish",
        name: "finish",
        arguments: {
          outcome: "completed",
          summary: "Confirmed the authorized directory.",
          verification: [{ description: "Prompt listed the directory", result: "passed" }],
        },
      },
    }];
  }]);

  const outcome = await runTask({
    task: "Inspect the additional directory",
    model,
    runtime: await ActionRuntime.create(root, defaultConfig, new Approval(true), new NoCommands(), {}, [additionalDirectory]),
    instructions: [],
    modelName: "scripted",
    maxTurns: 1,
  });

  assert.equal(outcome.status, "completed");
});

test("the /init task is handled as a conversation slash command", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-run-"));
  const model = new ScriptedModel([(turn) => {
    assert.equal(turn.user, "/init");
    assert.ok(turn.system.includes("`/init`"));
    assert.match(turn.system, /do not modify it/);
    return [{
      type: "action",
      action: {
        callId: "finish",
        name: "finish",
        arguments: {
          outcome: "completed",
          summary: "Generated the starter instructions.",
          verification: [{ description: "Read AGENTS.md", result: "passed" }],
        },
      },
    }];
  }]);

  const outcome = await runTask({
    task: "/init",
    model,
    runtime: await runtime(root),
    instructions: [],
    modelName: "scripted",
    maxTurns: 1,
  });

  assert.equal(outcome.status, "completed");
});

test("a denied destructive action is returned to the model and can end blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-run-"));
  await writeFile(join(root, "obsolete.txt"), "remove me");
  const model = new ScriptedModel([
    [{
      type: "action",
      action: {
        callId: "delete",
        name: "apply_patch",
        arguments: { changes: [{ path: "obsolete.txt", oldText: "remove me", newText: null }] },
      },
    }],
    (turn) => {
      assert.equal(turn.actionResults?.[0]?.ok, false);
      return [{
        type: "action",
        action: {
          callId: "finish",
          name: "finish",
          arguments: {
            outcome: "blocked",
            summary: "Deletion was not approved.",
            verification: [{ description: "Deletion requires approval", result: "not_run" }],
          },
        },
      }];
    },
  ]);

  const outcome = await runTask({
    task: "Delete the obsolete file",
    model,
    runtime: await runtime(root, false),
    instructions: [],
    modelName: "scripted",
    maxTurns: 4,
  });

  assert.equal(outcome.status, "blocked");
  assert.equal(await readFile(join(root, "obsolete.txt"), "utf8"), "remove me");
});

test("a completed finish cannot hide a failed verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-run-"));
  const model = new ScriptedModel([[{
    type: "action",
    action: {
      callId: "finish",
      name: "finish",
      arguments: {
        outcome: "completed",
        summary: "Claimed completion.",
        verification: [{ description: "Tests", result: "failed" }],
      },
    },
  }]]);
  const outcome = await runTask({
    task: "Do nothing",
    model,
    runtime: await runtime(root),
    instructions: [],
    modelName: "scripted",
    maxTurns: 1,
  });
  assert.equal(outcome.status, "blocked");
});

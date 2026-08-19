import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActionRuntime, type ApprovalGate, type ApprovalRequest } from "../src/action-runtime.js";
import { CommandSandboxError, type CommandInvocation, type CommandSandbox, type SandboxedCommandResult, type SandboxException } from "../src/command-sandbox.js";
import { defaultConfig, loadConfig } from "../src/config.js";
import type { ActionRequest, ActionResult } from "../src/types.js";

class FixedApproval implements ApprovalGate {
  readonly requests: ApprovalRequest[] = [];

  constructor(private readonly value: boolean) {}

  async request(request: ApprovalRequest): Promise<boolean> {
    this.requests.push(request);
    return this.value;
  }
}

class FallbackCommandSandbox implements CommandSandbox {
  async run(_command: CommandInvocation, _exceptions: SandboxException[] = []): Promise<SandboxedCommandResult> {
    throw new CommandSandboxError("command_start_failed", "No test command configured");
  }
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "froe-test-"));
}

async function runtime(root: string, approval = true, commandSandbox: CommandSandbox = new FallbackCommandSandbox()): Promise<ActionRuntime> {
  return ActionRuntime.create(root, defaultConfig, new FixedApproval(approval), commandSandbox);
}

function action(name: string, arguments_: unknown): ActionRequest {
  return { callId: "call_1", name, arguments: arguments_ };
}

function output(result: ActionResult): Record<string, unknown> {
  assert.equal(result.ok, true, JSON.stringify(result.output));
  assert.equal(typeof result.output, "object");
  assert.notEqual(result.output, null);
  assert.equal(Array.isArray(result.output), false);
  return result.output as Record<string, unknown>;
}

test("patch preflight leaves every file untouched when one replacement does not match", async () => {
  const root = await workspace();
  const target = join(root, "sample.txt");
  await writeFile(target, "first\nsecond\n");
  const result = await (await runtime(root)).execute(action("apply_patch", {
    changes: [
      { path: "sample.txt", oldText: "first", newText: "changed" },
      { path: "sample.txt", oldText: "missing", newText: "ignored" },
    ],
  }));

  assert.equal(result.ok, false);
  assert.deepEqual(result.output, { code: "duplicate_path", message: "A patch may only change sample.txt once" });
  assert.equal(await readFile(target, "utf8"), "first\nsecond\n");
});

test("patch mismatch is atomic across distinct files", async () => {
  const root = await workspace();
  await writeFile(join(root, "one.txt"), "one");
  await writeFile(join(root, "two.txt"), "two");
  const result = await (await runtime(root)).execute(action("apply_patch", {
    changes: [
      { path: "one.txt", oldText: "one", newText: "changed" },
      { path: "two.txt", oldText: "missing", newText: "ignored" },
    ],
  }));

  assert.equal(result.ok, false);
  assert.equal(await readFile(join(root, "one.txt"), "utf8"), "one");
  assert.equal(await readFile(join(root, "two.txt"), "utf8"), "two");
});

test("workspace escapes and symlinks are rejected", async () => {
  const root = await workspace();
  const outside = join(tmpdir(), `froe-outside-${Date.now()}.txt`);
  await writeFile(outside, "outside");
  await symlink(outside, join(root, "escape.txt"));
  const instance = await runtime(root);

  const escaped = await instance.execute(action("read_file", { path: "../outside.txt" }));
  assert.equal(escaped.ok, false);
  assert.deepEqual(escaped.output, { code: "workspace_escape", message: "Path escapes the workspace: ../outside.txt" });

  const linked = await instance.execute(action("read_file", { path: "escape.txt" }));
  assert.equal(linked.ok, false);
  assert.deepEqual(linked.output, { code: "symlink_forbidden", message: "Path contains a symbolic link: escape.txt" });
});

test("search returns normalized, line-oriented matches", async () => {
  const root = await workspace();
  await writeFile(join(root, "notes.txt"), "first line\nneedle here\nlast line\n");
  const result = await (await runtime(root)).execute(action("search", { query: "needle" }));
  const value = output(result);
  assert.equal(value.query, "needle");
  assert.deepEqual(value.results, [{ path: "notes.txt", line: 2, text: "needle here" }]);
});

test("commands strip the OpenAI key and pass timeout behavior through the sandbox seam", async () => {
  const root = await workspace();
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-reach-child";
  try {
    const commandSandbox: CommandSandbox = {
      async run(command): Promise<SandboxedCommandResult> {
        if (command.args[1]?.includes("OPENAI_API_KEY")) {
          return { exitCode: 0, signal: null, timedOut: false, output: command.env.OPENAI_API_KEY ?? "missing", truncated: false };
        }
        return { exitCode: null, signal: "SIGTERM", timedOut: true, output: "", truncated: false };
      },
    };
    const instance = await runtime(root, true, commandSandbox);
    const keyResult = await instance.execute(action("run_command", {
      executable: process.execPath,
      args: ["-e", "process.stdout.write(process.env.OPENAI_API_KEY ?? 'missing')"],
    }));
    assert.equal(output(keyResult).output, "missing");

    const timeoutResult = await instance.execute(action("run_command", {
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1000)"],
      timeoutMs: 25,
    }));
    assert.equal(output(timeoutResult).timedOut, true);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("ordinary commands run first and an OS denial requests a narrow retry exception", async () => {
  const root = await workspace();
  const deniedPath = join(root, "approved-output.txt");
  const calls: SandboxException[][] = [];
  const commandSandbox: CommandSandbox = {
    async run(_command, exceptions = []): Promise<SandboxedCommandResult> {
      calls.push(exceptions);
      if (exceptions.length === 0) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          output: "Operation not permitted",
          truncated: false,
          denial: {
            violations: [{ operation: "file-write-create", target: deniedPath }],
            exceptions: [{ type: "file-write", path: deniedPath }],
            reason: `macOS blocked file-write-create ${deniedPath}.`,
            destructive: true,
          },
        };
      }
      return { exitCode: 0, signal: null, timedOut: false, output: "retried", truncated: false };
    },
  };
  const approval = new FixedApproval(true);
  const instance = await ActionRuntime.create(root, defaultConfig, approval, commandSandbox);
  const result = await instance.execute(action("run_command", { executable: "custom-tool" }));
  const value = output(result);

  assert.deepEqual(calls, [[], [{ type: "file-write", path: deniedPath }]]);
  assert.equal(approval.requests.length, 1);
  assert.equal(approval.requests[0]?.scope, "sandbox_exception");
  assert.equal(approval.requests[0]?.destructive, true);
  assert.equal(value.sandboxed, true);
  assert.deepEqual(value.sandboxExceptions, [{ type: "file-write", path: deniedPath }]);
});

test("workspace configuration cannot grant command environment access", async () => {
  const root = await workspace();
  await mkdir(join(root, ".froe"));
  await writeFile(join(root, ".froe", "config.json"), JSON.stringify({ commandEnv: ["DATABASE_URL"] }));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = await workspace();
  try {
    await assert.rejects(() => loadConfig({ workspace: root }), /commandEnv is allowed only in user configuration/);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test("workspace configuration cannot select an API endpoint", async () => {
  const root = await workspace();
  await mkdir(join(root, ".froe"));
  await writeFile(join(root, ".froe", "config.json"), JSON.stringify({ baseURL: "https://api.example.com/v1" }));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = await workspace();
  try {
    await assert.rejects(() => loadConfig({ workspace: root }), /baseURL is allowed only in user configuration/);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

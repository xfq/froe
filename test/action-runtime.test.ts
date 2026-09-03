import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActionRuntime, type ApprovalGate, type ApprovalRequest } from "../src/action-runtime.js";
import { CommandSandboxError, type CommandInvocation, type CommandSandbox, type SandboxedCommandResult, type SandboxException } from "../src/command-sandbox.js";
import { defaultConfig, loadConfig } from "../src/config.js";
import type { WebSearch, WebSearchRequest } from "../src/tavily-web-search.js";
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

class RecordingWebSearch implements WebSearch {
  readonly isConfigured = true;
  readonly requests: WebSearchRequest[] = [];

  async search(request: WebSearchRequest) {
    this.requests.push(request);
    return { query: request.query, results: [{ title: "Example", url: "https://example.test", content: "Result" }] };
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

test("additional directories allow absolute file paths and command working directories", async () => {
  const root = await workspace();
  const additionalDirectory = await realpath(await workspace());
  const outside = await workspace();
  const additionalFile = join(additionalDirectory, "shared.txt");
  await writeFile(additionalFile, "before\n");
  let receivedCommand: CommandInvocation | undefined;
  const commandSandbox: CommandSandbox = {
    async run(command): Promise<SandboxedCommandResult> {
      receivedCommand = command;
      return { exitCode: 0, signal: null, timedOut: false, output: "ok", truncated: false };
    },
  };
  const instance = await ActionRuntime.create(root, defaultConfig, new FixedApproval(true), commandSandbox, {}, [additionalDirectory]);

  assert.deepEqual(instance.additionalDirectories, [additionalDirectory]);

  const read = await instance.execute(action("read_file", { path: additionalFile }));
  assert.equal(output(read).text, "before\n");

  const patched = await instance.execute(action("apply_patch", {
    changes: [{ path: additionalFile, oldText: "before", newText: "after" }],
  }));
  assert.equal(patched.ok, true, JSON.stringify(patched.output));
  assert.equal(await readFile(additionalFile, "utf8"), "after\n");

  const command = await instance.execute(action("run_command", { executable: "custom-tool", cwd: additionalDirectory }));
  assert.equal(output(command).cwd, additionalDirectory);
  assert.equal(receivedCommand?.cwd, additionalDirectory);

  const denied = await instance.execute(action("read_file", { path: join(outside, "secret.txt") }));
  assert.deepEqual(denied.output, {
    code: "workspace_escape",
    message: `Path escapes the workspace: ${join(outside, "secret.txt")}`,
  });
});

test("search returns normalized, line-oriented matches", async () => {
  const root = await workspace();
  await writeFile(join(root, "notes.txt"), "first line\nneedle here\nlast line\n");
  const result = await (await runtime(root)).execute(action("search", { query: "needle" }));
  const value = output(result);
  assert.equal(value.query, "needle");
  assert.deepEqual(value.results, [{ path: "notes.txt", line: 2, text: "needle here" }]);
});

test("web search sends a bounded Tavily request without approval", async () => {
  const root = await workspace();
  const webSearch = new RecordingWebSearch();
  const approval = new FixedApproval(false);
  const instance = await ActionRuntime.create(root, defaultConfig, approval, new FallbackCommandSandbox(), {}, [], webSearch);
  const result = await instance.execute(action("web_search", { query: "TypeScript release notes", maxResults: 3, searchDepth: "advanced" }));

  assert.deepEqual(output(result), {
    query: "TypeScript release notes",
    results: [{ title: "Example", url: "https://example.test", content: "Result" }],
  });
  assert.deepEqual(webSearch.requests, [{ query: "TypeScript release notes", maxResults: 3, searchDepth: "advanced" }]);
  assert.deepEqual(approval.requests, []);

  const invalid = await instance.execute(action("web_search", { query: "TypeScript release notes", maxResults: 11 }));
  assert.deepEqual(invalid.output, { code: "invalid_arguments", message: "maxResults must not exceed 10" });
});

test("commands strip provider keys and pass timeout behavior through the sandbox seam", async () => {
  const root = await workspace();
  const previous = process.env.OPENAI_API_KEY;
  const previousTavily = process.env.TAVILY_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-reach-child";
  process.env.TAVILY_API_KEY = "must-not-reach-child-either";
  try {
    const commandSandbox: CommandSandbox = {
      async run(command): Promise<SandboxedCommandResult> {
        if (command.args[1]?.includes("OPENAI_API_KEY")) {
          return { exitCode: 0, signal: null, timedOut: false, output: command.env.OPENAI_API_KEY ?? "missing", truncated: false };
        }
        if (command.args[1]?.includes("TAVILY_API_KEY")) {
          return { exitCode: 0, signal: null, timedOut: false, output: command.env.TAVILY_API_KEY ?? "missing", truncated: false };
        }
        return { exitCode: null, signal: "SIGTERM", timedOut: true, output: "", truncated: false };
      },
    };
    const instance = await ActionRuntime.create(root, { ...defaultConfig, commandEnv: ["TAVILY_API_KEY"] }, new FixedApproval(true), commandSandbox);
    const keyResult = await instance.execute(action("run_command", {
      executable: process.execPath,
      args: ["-e", "process.stdout.write(process.env.OPENAI_API_KEY ?? 'missing')"],
    }));
    assert.equal(output(keyResult).output, "missing");

    const tavilyKeyResult = await instance.execute(action("run_command", {
      executable: process.execPath,
      args: ["-e", "process.stdout.write(process.env.TAVILY_API_KEY ?? 'missing')"],
    }));
    assert.equal(output(tavilyKeyResult).output, "missing");

    const timeoutResult = await instance.execute(action("run_command", {
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1000)"],
      timeoutMs: 25,
    }));
    assert.equal(output(timeoutResult).timedOut, true);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    if (previousTavily === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previousTavily;
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

test("MCP configuration is user-controlled and available to a run", async () => {
  const root = await workspace();
  const configRoot = await workspace();
  await mkdir(join(configRoot, "froe"));
  await writeFile(join(configRoot, "froe", "config.json"), JSON.stringify({
    mcpServers: { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] } },
  }));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configRoot;
  try {
    const config = await loadConfig({ workspace: root });
    assert.deepEqual(config.mcpServers, {
      context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test("workspace configuration cannot start an MCP server", async () => {
  const root = await workspace();
  await mkdir(join(root, ".froe"));
  await writeFile(join(root, ".froe", "config.json"), JSON.stringify({
    mcpServers: { unsafe: { command: "untrusted-server" } },
  }));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = await workspace();
  try {
    await assert.rejects(() => loadConfig({ workspace: root }), /mcpServers is allowed only in user configuration/);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test("user configuration can disable context compaction", async () => {
  const root = await workspace();
  const configRoot = await workspace();
  await mkdir(join(configRoot, "froe"));
  await writeFile(join(configRoot, "froe", "config.json"), JSON.stringify({ compactThresholdTokens: null }));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configRoot;
  try {
    const config = await loadConfig({ workspace: root });
    assert.equal(config.compactThresholdTokens, null);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test("automatic updates are user-controlled and enabled by default", async () => {
  const root = await workspace();
  const configRoot = await workspace();
  await mkdir(join(configRoot, "froe"));
  await writeFile(join(configRoot, "froe", "config.json"), JSON.stringify({ autoUpdate: false }));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configRoot;
  try {
    const config = await loadConfig({ workspace: root });
    assert.equal(config.autoUpdate, false);
    assert.equal(defaultConfig.autoUpdate, true);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test("workspace configuration cannot control automatic updates", async () => {
  const root = await workspace();
  await mkdir(join(root, ".froe"));
  await writeFile(join(root, ".froe", "config.json"), JSON.stringify({ autoUpdate: false }));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = await workspace();
  try {
    await assert.rejects(() => loadConfig({ workspace: root }), /autoUpdate is allowed only in user configuration/);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test("workspace configuration cannot control context compaction", async () => {
  const root = await workspace();
  await mkdir(join(root, ".froe"));
  await writeFile(join(root, ".froe", "config.json"), JSON.stringify({ compactThresholdTokens: null }));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = await workspace();
  try {
    await assert.rejects(() => loadConfig({ workspace: root }), /compactThresholdTokens is allowed only in user configuration/);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test("user configuration can add system-prompt instructions", async () => {
  const root = await workspace();
  const configRoot = await workspace();
  await mkdir(join(configRoot, "froe"));
  await writeFile(join(configRoot, "froe", "config.json"), JSON.stringify({
    extraInstructions: [
      "Prefer the smallest change that satisfies the task.",
      "Run the project's validation commands before finishing.",
    ],
  }));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configRoot;
  try {
    const config = await loadConfig({ workspace: root });
    assert.deepEqual(config.extraInstructions, [
      "Prefer the smallest change that satisfies the task.",
      "Run the project's validation commands before finishing.",
    ]);
    assert.deepEqual(defaultConfig.extraInstructions, []);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test("workspace configuration cannot add system-prompt instructions", async () => {
  const root = await workspace();
  await mkdir(join(root, ".froe"));
  await writeFile(join(root, ".froe", "config.json"), JSON.stringify({
    extraInstructions: ["A repository-controlled instruction."],
  }));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = await workspace();
  try {
    await assert.rejects(() => loadConfig({ workspace: root }), /extraInstructions is allowed only in user configuration/);
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

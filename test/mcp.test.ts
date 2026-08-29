import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActionRuntime, type ApprovalGate, type ApprovalRequest } from "../src/action-runtime.js";
import { CommandSandboxError, type CommandInvocation, type CommandSandbox, type SandboxedCommandResult, type SandboxException } from "../src/command-sandbox.js";
import { defaultConfig } from "../src/config.js";
import { McpManager } from "../src/mcp.js";
import { runTask } from "../src/run.js";
import { ScriptedModel } from "../src/scripted-model.js";

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

test("an active stdio MCP server contributes tools and returns its context to the model", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-mcp-"));
  const serverPath = join(root, "server.mjs");
  await writeFile(serverPath, fixtureServer);
  const mcp = await McpManager.connect({
    docs: { command: process.execPath, args: [serverPath] },
  });
  const runtime = await ActionRuntime.create(root, defaultConfig, new Approval(), new NoCommands());
  const model = new ScriptedModel([
    (turn) => {
      assert.deepEqual(mcp.activeServers, [{ name: "docs", toolCount: 1 }]);
      assert.deepEqual(turn.tools.find((tool) => tool.name === "mcp__docs__lookup"), {
        name: "mcp__docs__lookup",
        description: "Look up developer documentation.",
        parameters: {
          type: "object",
          properties: { topic: { type: "string" } },
          required: ["topic"],
        },
      });
      return [{
        type: "action",
        action: { callId: "lookup", name: "mcp__docs__lookup", arguments: { topic: "MCP" } },
      }];
    },
    (turn) => {
      assert.deepEqual(turn.actionResults?.[0], {
        callId: "lookup",
        name: "mcp__docs__lookup",
        ok: true,
        output: { content: [{ type: "text", text: "MCP connects models to tools and context." }] },
      });
      return [{
        type: "action",
        action: {
          callId: "finish",
          name: "finish",
          arguments: {
            outcome: "completed",
            summary: "Used MCP documentation.",
            verification: [{ description: "MCP fixture returned documentation", result: "passed" }],
          },
        },
      }];
    },
  ]);

  try {
    const outcome = await runTask({
      task: "Look up MCP documentation",
      model,
      runtime,
      mcp,
      instructions: [],
      modelName: "scripted",
      maxTurns: 2,
    });

    assert.equal(outcome.status, "completed");
  } finally {
    await mcp.close();
  }
});

test("a stopped MCP server is no longer reported as active", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-mcp-"));
  const serverPath = join(root, "server.mjs");
  await writeFile(serverPath, fixtureServer);
  const mcp = await McpManager.connect({
    docs: { command: process.execPath, args: [serverPath, "--exit-after-list"] },
  });

  try {
    assert.deepEqual(mcp.activeServers, [{ name: "docs", toolCount: 1 }]);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(mcp.activeServers, []);
    assert.deepEqual(mcp.tools, []);
    assert.equal(mcp.hasTool("mcp__docs__lookup"), false);
  } finally {
    await mcp.close();
  }
});

test("a cancelled MCP tool call stops waiting and ignores its late result", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-mcp-"));
  const serverPath = join(root, "server.mjs");
  await writeFile(serverPath, fixtureServer);
  const mcp = await McpManager.connect({
    docs: { command: process.execPath, args: [serverPath, "--delay-tool-call"] },
  });
  const controller = new AbortController();
  const first = mcp.execute({
    callId: "first",
    name: "mcp__docs__lookup",
    arguments: { topic: "first" },
  }, controller.signal);
  controller.abort();
  let deadline: NodeJS.Timeout | undefined;

  try {
    const result = await Promise.race([
      first,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("MCP cancellation waited for the tool response.")), 200);
      }),
    ]);
    assert.deepEqual(result, {
      callId: "first",
      name: "mcp__docs__lookup",
      ok: false,
      output: { code: "mcp_tool_failed", message: "Run cancelled" },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    const second = await mcp.execute({
      callId: "second",
      name: "mcp__docs__lookup",
      arguments: { topic: "second" },
    });
    assert.deepEqual(second, {
      callId: "second",
      name: "mcp__docs__lookup",
      ok: true,
      output: { content: [{ type: "text", text: "Delayed MCP tool call 2." }] },
    });
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    await mcp.close();
  }
});

const fixtureServer = String.raw`
let buffer = "";
let toolCalls = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      respond(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } });
    } else if (request.method === "tools/list") {
      respond(request.id, { tools: [{ name: "lookup", description: "Look up developer documentation.", inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] } }] });
      if (process.argv.includes("--exit-after-list")) setTimeout(() => process.exit(0), 10);
    } else if (request.method === "tools/call") {
      toolCalls += 1;
      const result = process.argv.includes("--delay-tool-call")
        ? { content: [{ type: "text", text: "Delayed MCP tool call " + toolCalls + "." }] }
        : { content: [{ type: "text", text: "MCP connects models to tools and context." }] };
      if (process.argv.includes("--delay-tool-call")) setTimeout(() => respond(request.id, result), 50);
      else respond(request.id, result);
    }
  }
});
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
`;

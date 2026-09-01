import assert from "node:assert/strict";
import test from "node:test";
import { runConversation } from "../src/conversation.js";
import { defaultConfig } from "../src/config.js";
import type { FroeRunRequest, FroeSession, FroeSessionStatus } from "../src/session.js";
import type { RunOutcome } from "../src/types.js";
import type { TerminalMessage } from "../src/terminal-conversation.js";

class RecordingSession implements FroeSession {
  readonly requests: FroeRunRequest[] = [];
  readonly #status: FroeSessionStatus = {
    interfaceVersion: 1,
    sessionId: "test-session",
    workspace: "/workspace",
    additionalDirectories: [],
    config: structuredClone(defaultConfig),
    activeMcpServers: [{ name: "docs", toolCount: 2 }],
    mcpFailures: [],
  };

  status(): FroeSessionStatus {
    return structuredClone(this.#status);
  }

  async run(request: FroeRunRequest): Promise<RunOutcome> {
    this.requests.push(request);
    return {
      status: "completed",
      summary: `Handled ${request.task}`,
      verification: [{ description: "Test adapter", result: "passed" }],
      turns: 1,
    };
  }

  async close(): Promise<void> {}
}

test("the terminal conversation adapter sends follow-ups through one core session", async () => {
  const session = new RecordingSession();
  const outcomes = await runConversation({
    session,
    messages: messages("Implement the feature", "Please add tests too"),
    imagePaths: ["/tmp/screenshot.png"],
  });

  assert.deepEqual(session.requests, [
    {
      task: "Implement the feature",
      imagePaths: ["/tmp/screenshot.png"],
      model: defaultConfig.model,
    },
    { task: "Please add tests too", model: defaultConfig.model },
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.summary), [
    "Handled Implement the feature",
    "Handled Please add tests too",
  ]);
});

test("the terminal conversation adapter changes models between core runs", async () => {
  const session = new RecordingSession();
  const selected: string[] = [];

  await runConversation({
    session,
    messages: messages("First task", { type: "model", model: "gpt-5.6-sol" }, "Second task"),
    onModelSelected: (model) => {
      selected.push(model);
    },
  });

  assert.deepEqual(selected, ["gpt-5.6-sol"]);
  assert.deepEqual(session.requests.map((request) => request.model), [defaultConfig.model, "gpt-5.6-sol"]);
});

test("the terminal conversation adapter reads MCP status without starting a run", async () => {
  const session = new RecordingSession();
  const statuses: FroeSessionStatus[] = [];

  const outcomes = await runConversation({
    session,
    messages: messages({ type: "mcp" }),
    showMcpServers: (status) => {
      statuses.push(status);
    },
  });

  assert.deepEqual(outcomes, []);
  assert.equal(session.requests.length, 0);
  assert.deepEqual(statuses[0]?.activeMcpServers, [{ name: "docs", toolCount: 2 }]);
});

test("the terminal conversation adapter starts a fresh conversation on reset", async () => {
  const session = new RecordingSession();
  let resets = 0;

  const outcomes = await runConversation({
    session,
    messages: messages("First task", { type: "reset" }, "Second task"),
    onResetConversation: () => {
      resets += 1;
    },
  });

  assert.deepEqual(session.requests.map((request) => request.task), ["First task", "Second task"]);
  assert.deepEqual(outcomes.map((outcome) => outcome.summary), [
    "Handled First task",
    "Handled Second task",
  ]);
  assert.equal(resets, 1);
});

async function* messages(...values: Array<string | TerminalMessage>): AsyncGenerator<TerminalMessage> {
  for (const value of values) yield typeof value === "string" ? { type: "task", text: value } : value;
}

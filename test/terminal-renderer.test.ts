import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createTerminalRenderer } from "../src/terminal-renderer.js";

test("a conversation turn keeps its message and all response output under one number", () => {
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk: Buffer) => {
    rendered += chunk.toString();
  });
  const renderer = createTerminalRenderer({ output, verbose: true, recordPath: undefined, conversationMode: true });

  renderer.startConversationTurn({ number: 4, message: "Inspect the session state" });
  renderer.render({ type: "model_text", text: "I will inspect it.\nThen I will report back." });
  renderer.render({ type: "action_requested", action: { callId: "read", name: "read_file", arguments: { path: "src/session.ts" } } });
  renderer.render({ type: "action_result", result: { callId: "read", name: "read_file", ok: true, output: { path: "src/session.ts" } } });
  renderer.render({
    type: "run_finished",
    outcome: { status: "completed", summary: "Session state inspected.", verification: [{ description: "Read the session module", result: "passed" }], turns: 1 },
  });

  assert.equal(rendered, [
    "\n[4] you: Inspect the session state\n",
    "[4] froe:\n",
    "[4] froe: I will inspect it.\n",
    "[4] froe: Then I will report back.\n",
    "[4] → read_file\n",
    "[4]   path: \"src/session.ts\"\n",
    "[4] ✓ read_file\n",
    "[4] {\n",
    "[4]   \"path\": \"src/session.ts\"\n",
    "[4] }\n",
    "[4] completed: Session state inspected.\n",
    "[4]   passed: Read the session module\n",
  ].join(""));
});

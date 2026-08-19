import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { completeSlashCommand, terminalMessages } from "../src/terminal-conversation.js";

test("slash-command completion offers supported commands only", () => {
  assert.deepEqual(completeSlashCommand("/"), [["/exit", "/init"], "/"]);
  assert.deepEqual(completeSlashCommand("/i"), [["/init"], "/i"]);
  assert.deepEqual(completeSlashCommand("/unknown"), [[], "/unknown"]);
  assert.deepEqual(completeSlashCommand("implement feature"), [[], "implement feature"]);
});

test("terminal input accepts follow-ups and releases stdin between messages", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  const messages = terminalMessages(input, output, controller.signal)[Symbol.asyncIterator]();

  const first = messages.next();
  input.write("Inspect the workspace\n");
  assert.deepEqual(await first, { value: "Inspect the workspace", done: false });
  assert.equal(input.listenerCount("data"), 0);

  const second = messages.next();
  input.write("Please check again\n");
  assert.deepEqual(await second, { value: "Please check again", done: false });
  assert.equal(input.listenerCount("data"), 0);

  const exit = messages.next();
  input.write("/exit\n");
  assert.deepEqual(await exit, { value: undefined, done: true });
});

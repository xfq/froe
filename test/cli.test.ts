import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { completeSlashCommand, terminalMessages } from "../src/terminal-conversation.js";

const execFile = promisify(execFileCallback);

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

test("CLI prints its package version without starting a run", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const repository = new URL("..", import.meta.url).pathname;
  const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
  const { stdout, stderr } = await execFile(tsx, ["src/cli.ts", "--version"], {
    cwd: repository,
    encoding: "utf8",
  });

  assert.equal(stdout, `froe ${manifest.version}\n`);
  assert.equal(stderr, "");
});

test("CLI help documents attachments, additional directories, and update control", async () => {
  const repository = new URL("..", import.meta.url).pathname;
  const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
  const { stdout, stderr } = await execFile(tsx, ["src/cli.ts", "--help"], {
    cwd: repository,
    encoding: "utf8",
  });

  assert.equal(stdout, "");
  assert.match(stderr, /--image <path>.*repeatable/);
  assert.match(stderr, /--add-dir <path>.*repeatable/);
  assert.match(stderr, /--no-update.*automatic update check/);
});

test("CLI accepts repeated additional directory options", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const repository = new URL("..", import.meta.url).pathname;
  const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
  const { stdout, stderr } = await execFile(tsx, ["src/cli.ts", "--add-dir", ".", "--add-dir", ".", "--version"], {
    cwd: repository,
    encoding: "utf8",
  });

  assert.equal(stdout, `froe ${manifest.version}\n`);
  assert.equal(stderr, "");
});

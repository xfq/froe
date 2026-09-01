import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { completeSlashCommand, terminalMessages } from "../src/terminal-conversation.js";

const execFile = promisify(execFileCallback);

test("slash-command completion offers supported commands only", () => {
  assert.deepEqual(completeSlashCommand("/"), [["/exit", "/init", "/mcp", "/model", "/new"], "/"]);
  assert.deepEqual(completeSlashCommand("/i"), [["/init"], "/i"]);
  assert.deepEqual(completeSlashCommand("/mcp"), [["/mcp"], "/mcp"]);
  assert.deepEqual(completeSlashCommand("/m"), [["/mcp", "/model"], "/m"]);
  assert.deepEqual(completeSlashCommand("/n"), [["/new"], "/n"]);
  assert.deepEqual(completeSlashCommand("/unknown"), [[], "/unknown"]);
  assert.deepEqual(completeSlashCommand("implement feature"), [[], "implement feature"]);
});

test("terminal input treats MCP status as a control command", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  const messages = terminalMessages(input, output, controller.signal)[Symbol.asyncIterator]();

  const status = messages.next();
  input.write("/mcp\n");

  assert.deepEqual(await status, { value: { type: "mcp" }, done: false });
  controller.abort();
});

test("terminal input accepts follow-ups and releases stdin between messages", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  const messages = terminalMessages(input, output, controller.signal)[Symbol.asyncIterator]();

  const first = messages.next();
  input.write("Inspect the workspace\n");
  assert.deepEqual(await first, { value: { type: "task", text: "Inspect the workspace" }, done: false });
  assert.equal(input.listenerCount("data"), 0);

  const second = messages.next();
  input.write("Please check again\n");
  assert.deepEqual(await second, { value: { type: "task", text: "Please check again" }, done: false });
  assert.equal(input.listenerCount("data"), 0);

  const exit = messages.next();
  input.write("/exit\n");
  assert.deepEqual(await exit, { value: undefined, done: true });
});

test("terminal input treats model selection as a control command", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  const messages = terminalMessages(input, output, controller.signal)[Symbol.asyncIterator]();
  let terminalOutput = "";
  const usage = new Promise<void>((resolve) => {
    output.on("data", (chunk: Buffer) => {
      terminalOutput += chunk.toString();
      if (terminalOutput.includes("Usage: /model <model-id>\n")) resolve();
    });
  });

  const selection = messages.next();
  input.write("/model gpt-5.6-sol\n");
  assert.deepEqual(await selection, { value: { type: "model", model: "gpt-5.6-sol" }, done: false });

  const following = messages.next();
  input.write("/model\n");
  await usage;
  input.write("Continue the task\n");
  assert.deepEqual(await following, { value: { type: "task", text: "Continue the task" }, done: false });
  assert.match(terminalOutput, /Usage: \/model <model-id>/);
  controller.abort();
});

test("terminal input treats new-conversation as a control command", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  const messages = terminalMessages(input, output, controller.signal)[Symbol.asyncIterator]();

  const reset = messages.next();
  input.write("/new\n");
  assert.deepEqual(await reset, { value: { type: "reset" }, done: false });

  const following = messages.next();
  input.write("Continue fresh\n");
  assert.deepEqual(await following, { value: { type: "task", text: "Continue fresh" }, done: false });
  controller.abort();
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

test("CLI help documents attachments, additional directories, update control, and Tavily setup", async () => {
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
  assert.match(stderr, /--configure-tavily.*private credential file/);
  assert.match(stderr, /froe mcp add <name> -- <command> \[args\.\.\.\]/);
  assert.match(stderr, /froe mcp add <name> --url <url>/);
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

test("Tavily setup is an interactive command that does not start a coding run", async () => {
  const repository = new URL("..", import.meta.url).pathname;
  const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;

  await assert.rejects(
    execFile(tsx, ["src/cli.ts", "--configure-tavily"], { cwd: repository, encoding: "utf8" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(String((error as { stderr?: unknown }).stderr), /--configure-tavily requires an interactive terminal/);
      return true;
    },
  );
});

test("MCP add stores a stdio server in user configuration without starting a run", async () => {
  const repository = new URL("..", import.meta.url).pathname;
  const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
  const configHome = await mkdtemp(join(tmpdir(), "froe-mcp-config-"));
  await mkdir(join(configHome, "froe"));
  await writeFile(join(configHome, "froe", "config.json"), JSON.stringify({
    $schema: "https://example.test/froe.schema.json",
    model: "gpt-5.6-sol",
  }));
  const { stdout, stderr } = await execFile(
    tsx,
    ["src/cli.ts", "mcp", "add", "context7", "--", "npx", "-y", "@upstash/context7-mcp"],
    { cwd: repository, encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: configHome } },
  );

  assert.equal(stdout, "");
  assert.equal(stderr, "MCP server context7 added.\n");
  assert.deepEqual(JSON.parse(await readFile(join(configHome, "froe", "config.json"), "utf8")), {
    $schema: "https://example.test/froe.schema.json",
    model: "gpt-5.6-sol",
    mcpServers: {
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
    },
  });
});

test("MCP add stores a remote server URL in user configuration without starting a run", async () => {
  const repository = new URL("..", import.meta.url).pathname;
  const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
  const configHome = await mkdtemp(join(tmpdir(), "froe-mcp-config-"));
  const { stdout, stderr } = await execFile(
    tsx,
    ["src/cli.ts", "mcp", "add", "my-server", "--url", "https://example.com/mcp"],
    { cwd: repository, encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: configHome } },
  );

  assert.equal(stdout, "");
  assert.equal(stderr, "MCP server my-server added.\n");
  assert.deepEqual(JSON.parse(await readFile(join(configHome, "froe", "config.json"), "utf8")), {
    mcpServers: {
      "my-server": { url: "https://example.com/mcp" },
    },
  });
});

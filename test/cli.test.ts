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

test("terminal input preserves all lines delivered together as one task", async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  const messages = terminalMessages(input, new PassThrough(), controller.signal);
  try {
    const first = messages.next();
    input.write("第一行任务\n\n  第二行约束\n第三行验收\n");
    assert.deepEqual(await first, {
      value: { type: "task", text: "第一行任务\n\n  第二行约束\n第三行验收" }, done: false,
    });
    assert.equal(input.listenerCount("data"), 0);
  } finally {
    controller.abort();
    await messages.return(undefined);
  }
});

test("terminal input buffers bracketed paste across chunks until Enter", async () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean): void { this.isRaw = mode; },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  const controller = new AbortController();
  const messages = terminalMessages(input, output, controller.signal);
  let submitted = false;
  try {
    const first = messages.next().then((result) => { submitted = true; return result; });
    input.write("\u001b[20");
    input.write("0~/exit\r\n\r\n  ");
    const chinese = Buffer.from("中文约束");
    input.write(chinese.subarray(0, 2));
    input.write(chinese.subarray(2));
    input.write("\r验收\u001b[201");
    input.write("~");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(submitted, false);
    input.write("\r");
    assert.deepEqual(await first, {
      value: { type: "task", text: "/exit\n\n  中文约束\n验收" }, done: false,
    });
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount("data"), 0);
    const next = messages.next();
    input.write("follow-up\r");
    assert.deepEqual(await next, { value: { type: "task", text: "follow-up" }, done: false });
  } finally {
    controller.abort();
    await messages.return(undefined);
  }
});

test("terminal paste preserves the cursor suffix and does not dispatch multiline model commands", async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  const messages = terminalMessages(input, new PassThrough(), controller.signal);
  try {
    const next = messages.next();
    input.write("/model tail\u001b[D\u001b[D\u001b[D\u001b[D");
    input.write("\u001b[200~example\n  context\u001b[201~\r");
    assert.deepEqual(await next, {
      value: { type: "task", text: "/model example\n  contexttail" }, done: false,
    });
  } finally {
    controller.abort();
    await messages.return(undefined);
  }
});

test("cancelling an incomplete paste restores terminal modes and releases stdin", async () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: true,
    setRawMode(mode: boolean): void { this.isRaw = mode; },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  let rendered = "";
  output.on("data", (chunk: Buffer) => { rendered += chunk.toString(); });
  const controller = new AbortController();
  const messages = terminalMessages(input, output, controller.signal);
  const next = messages.next();
  input.write("\u001b[200~unfinished\ntext");
  controller.abort();
  assert.deepEqual(await next, { value: undefined, done: true });
  assert.equal(input.isRaw, true);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("end"), 0);
  assert.equal(input.listenerCount("error"), 0);
  assert.ok(rendered.startsWith("\u001b[?2004h"));
  assert.ok(rendered.endsWith("\u001b[?2004l"));
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

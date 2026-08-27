#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stderr as output, stdout } from "node:process";
import type { ReadStream, WriteStream } from "node:tty";
import { ActionRuntime, type ApprovalGate, type ApprovalRequest } from "./action-runtime.js";
import { createCommandSandbox } from "./command-sandbox.js";
import { loadConfig } from "./config.js";
import { runConversation } from "./conversation.js";
import { DEFAULT_OPENAI_BASE_URL, FileCredentialStore, resolveOpenAICredentials } from "./credentials.js";
import { discoverProjectInstructions } from "./instructions.js";
import { OpenAIProvider } from "./openai-provider.js";
import { loadPromptImages } from "./prompt-images.js";
import { RunRecorder } from "./recorder.js";
import { runTask } from "./run.js";
import { terminalMessages } from "./terminal-conversation.js";
import type { EventSink, ReasoningEffort, RunEvent, RunOptions } from "./types.js";

const reasoningValues = new Set<ReasoningEffort>(["none", "low", "medium", "high", "xhigh", "max"]);
const packageVersion = await readPackageVersion();

async function main(): Promise<void> {
  const options = await parseOptions();
  const conversationMode = options.task === undefined;
  const credentials = await resolveOpenAICredentials({
    ...(process.env.OPENAI_API_KEY === undefined ? {} : { environmentApiKey: process.env.OPENAI_API_KEY }),
    ...(options.config.baseURL !== undefined
      ? { configuredBaseURL: options.config.baseURL }
      : process.env.OPENAI_BASE_URL === undefined
        ? {}
        : { configuredBaseURL: process.env.OPENAI_BASE_URL }),
    interactive: input.isTTY === true && output.isTTY === true,
    promptApiKey: () => promptForApiKey(input, output),
    promptBaseURL: (defaultValue) => promptForBaseURL(input, output, defaultValue),
    store: new FileCredentialStore(),
    onSaved: () => {
      output.write("OpenAI connection saved. Future runs will use it automatically.\n");
    },
  });
  const recorder = await RunRecorder.create(options.config.logging, options.noLog);
  const render = createRenderer(options.verbose, recorder.path, conversationMode);
  const sink: EventSink = async (event) => {
    await recorder.record(event);
    render(event);
  };
  const approval = new TerminalApproval(options.yes);
  const commandSandbox = await createCommandSandbox(options.workspace, options.additionalDirectories);
  const runtime = await ActionRuntime.create(
    options.workspace,
    options.config,
    approval,
    commandSandbox,
    {
      onApprovalRequested: async (request) => sink({ type: "approval_requested", action: request.action, reason: request.reason }),
    },
    options.additionalDirectories,
  );
  const instructions = await discoverProjectInstructions(runtime.workspace);
  const provider = new OpenAIProvider(options.config, credentials);
  const controller = new AbortController();
  let interrupted = false;
  const onInterrupt = (): void => {
    if (interrupted) process.exit(130);
    interrupted = true;
    controller.abort();
    output.write(`\n${conversationMode ? "Closing the conversation" : "Cancelling froe"}; completed changes will remain in the workspace. Press Ctrl-C again to exit immediately.\n`);
  };
  process.on("SIGINT", onInterrupt);
  try {
    if (options.task === undefined) {
      printConversationBanner(options.config.model, runtime.workspace, recorder.path);
      await runConversation({
        messages: terminalMessages(input, output, controller.signal),
        images: options.images,
        model: provider,
        runtime,
        instructions,
        modelName: options.config.model,
        maxTurns: options.config.maxTurns,
        signal: controller.signal,
        emit: sink,
      });
      process.exitCode = controller.signal.aborted ? 130 : 0;
    } else {
      const outcome = await runTask({
        task: options.task,
        images: options.images,
        model: provider,
        runtime,
        instructions,
        modelName: options.config.model,
        maxTurns: options.config.maxTurns,
        signal: controller.signal,
        emit: sink,
      });
      process.exitCode = outcome.status === "completed" ? 0 : outcome.status === "cancelled" ? 130 : 1;
    }
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

async function parseOptions(): Promise<RunOptions> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      workspace: { type: "string", short: "w" },
      "add-dir": { type: "string", multiple: true },
      "base-url": { type: "string" },
      model: { type: "string", short: "m" },
      reasoning: { type: "string" },
      image: { type: "string", multiple: true },
      config: { type: "string", short: "c" },
      "max-turns": { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      "no-log": { type: "boolean", default: false },
      version: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (parsed.values.help) {
    printHelp();
    process.exit(0);
  }
  if (parsed.values.version) {
    stdout.write(`froe ${packageVersion}\n`);
    process.exit(0);
  }
  const taskFromArguments = parsed.positionals.join(" ").trim();
  let task = taskFromArguments || undefined;
  if (task === undefined && input.isTTY !== true) task = (await taskFromStdin()).trim() || undefined;
  if (input.isTTY !== true && task === undefined) {
    throw new UsageError("Provide a task as positional text or pipe it through stdin.");
  }
  const workspace = resolve(stringOption(parsed.values.workspace) ?? process.cwd());
  const additionalDirectories = stringOptions(parsed.values["add-dir"]).map((path) => resolve(path));
  const reasoning = optionalReasoning(stringOption(parsed.values.reasoning));
  const images = await loadPromptImages(stringOptions(parsed.values.image));
  const maxTurns = optionalPositiveInteger(stringOption(parsed.values["max-turns"]), "--max-turns");
  const explicitConfigPath = stringOption(parsed.values.config);
  const config = await loadConfig({
    workspace,
    ...(explicitConfigPath === undefined ? {} : { configPath: explicitConfigPath }),
    overrides: {
      ...(stringOption(parsed.values["base-url"]) === undefined ? {} : { baseURL: stringOption(parsed.values["base-url"]) as string }),
      ...(stringOption(parsed.values.model) === undefined ? {} : { model: stringOption(parsed.values.model) as string }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(maxTurns === undefined ? {} : { maxTurns }),
    },
  });
  return {
    workspace,
    additionalDirectories,
    ...(task === undefined ? {} : { task }),
    images,
    config,
    yes: Boolean(parsed.values.yes),
    verbose: Boolean(parsed.values.verbose),
    noLog: Boolean(parsed.values["no-log"]),
  };
}

async function taskFromStdin(): Promise<string> {
  return readFile("/dev/stdin", "utf8");
}

async function readPackageVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error("Package manifest does not define a version.");
  return manifest.version;
}

async function promptForApiKey(terminalInput: ReadStream, terminalOutput: WriteStream): Promise<string> {
  terminalOutput.write(
    "No OpenAI API key is configured.\nCreate one at https://platform.openai.com/api-keys\nOpenAI API key (input hidden): ",
  );
  const wasRaw = terminalInput.isRaw;
  terminalInput.setRawMode(true);
  terminalInput.resume();

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = (): void => {
      terminalInput.off("data", onData);
      terminalInput.setRawMode(wasRaw);
      terminalInput.pause();
    };
    const finish = (): void => {
      cleanup();
      terminalOutput.write("\n");
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const byte of Buffer.from(chunk)) {
        if (byte === 3) {
          cleanup();
          terminalOutput.write("\n");
          reject(new Error("Sign-in cancelled."));
          return;
        }
        if (byte === 4 && value.length === 0) {
          finish();
          return;
        }
        if (byte === 10 || byte === 13) {
          finish();
          return;
        }
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 32) value += String.fromCharCode(byte);
      }
    };
    terminalInput.on("data", onData);
  });
}

async function promptForBaseURL(
  terminalInput: ReadStream,
  terminalOutput: WriteStream,
  defaultValue = DEFAULT_OPENAI_BASE_URL,
): Promise<string> {
  const readline = createInterface({ input: terminalInput, output: terminalOutput });
  try {
    return await readline.question(`OpenAI Base URL [default: ${defaultValue}]: `);
  } finally {
    readline.close();
  }
}

class TerminalApproval implements ApprovalGate {
  readonly #yes: boolean;
  readonly #alwaysApproved = new Set<string>();

  constructor(yes: boolean) {
    this.#yes = yes;
  }

  async request(request: ApprovalRequest): Promise<boolean> {
    const category = request.action.name;
    if (request.scope === "policy" && this.#alwaysApproved.has(category)) return true;
    if (request.scope === "policy" && this.#yes && !request.destructive) return true;
    if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
    const readline = createInterface({ input, output });
    try {
      const choices = request.scope === "sandbox_exception" || request.destructive ? "[y]es/[n]o" : "[y]es/[n]o/[a]ll this run";
      const answer = (await readline.question(`Approve ${request.action.name}? ${request.reason} ${choices}: `)).trim().toLowerCase();
      if (answer === "a" && request.scope === "policy" && !request.destructive) {
        this.#alwaysApproved.add(category);
        return true;
      }
      return answer === "y" || answer === "yes";
    } finally {
      readline.close();
    }
  }
}

function createRenderer(verbose: boolean, recordPath: string | undefined, conversationMode: boolean): (event: RunEvent) => void {
  return (event) => {
    switch (event.type) {
      case "run_started":
        if (!conversationMode) {
          output.write(`froe · ${event.model}\nworkspace: ${event.workspace}\n`);
          if (recordPath !== undefined) output.write(`record: ${recordPath}\n`);
        }
        break;
      case "model_text":
        if (event.text.trim()) output.write(`froe: ${event.text.trim()}\n`);
        break;
      case "action_requested":
        output.write(`→ ${event.action.name}${describeAction(event.action)}\n`);
        break;
      case "approval_requested":
        output.write(`! approval needed: ${event.reason}\n`);
        break;
      case "action_result":
        output.write(`${event.result.ok ? "✓" : "✗"} ${event.result.name}${resultSuffix(event.result)}\n`);
        if (verbose) output.write(`${JSON.stringify(event.result.output, null, 2)}\n`);
        break;
      case "usage":
        if (verbose) output.write(`usage: ${event.inputTokens} input, ${event.outputTokens} output tokens\n`);
        break;
      case "run_finished":
        output.write(`${event.outcome.status}: ${event.outcome.summary}\n`);
        for (const check of event.outcome.verification) output.write(`  ${check.result}: ${check.description}\n`);
        break;
    }
  };
}

function printConversationBanner(model: string, workspace: string, recordPath: string | undefined): void {
  output.write(`froe conversation · ${model}\nworkspace: ${workspace}\n`);
  if (recordPath !== undefined) output.write(`record: ${recordPath}\n`);
  output.write("Send a follow-up after each run, or type /exit to leave.\n");
}

function describeAction(action: { name: string; arguments: unknown }): string {
  if (!isRecord(action.arguments)) return "";
  if (typeof action.arguments.path === "string") return ` ${action.arguments.path}`;
  if (typeof action.arguments.executable === "string") return ` ${action.arguments.executable}`;
  return "";
}

function resultSuffix(result: { name: string; ok: boolean; output: unknown }): string {
  if (!result.ok && isRecord(result.output) && typeof result.output.message === "string") return ` — ${result.output.message}`;
  if (result.name === "run_command" && isRecord(result.output) && typeof result.output.exitCode === "number") return ` (exit ${result.output.exitCode})`;
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOption(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringOptions(value: string | string[] | boolean | undefined): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return [];
}

function optionalReasoning(value: string | undefined): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (!reasoningValues.has(value as ReasoningEffort)) throw new UsageError("--reasoning must be none, low, medium, high, xhigh, or max");
  return value as ReasoningEffort;
}

function optionalPositiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new UsageError(`${flag} must be a positive integer`);
  return parsed;
}

class UsageError extends Error {}

function printHelp(): void {
  output.write(`Usage: froe [options] [task...]\n\nRun without a task in an interactive terminal to start a conversation.\n\nOptions:\n  -w, --workspace <path>  Workspace directory (default: current directory)\n      --add-dir <path>     Additional directory with read/write access (repeatable)\n      --base-url <url>     OpenAI-compatible API endpoint\n  -m, --model <id>        OpenAI-compatible model (default: gpt-5.6-terra)\n      --reasoning <level>  none, low, medium, high, xhigh, or max\n      --image <path>       Attach a PNG, JPEG, WEBP, or GIF to the first prompt (repeatable)\n  -c, --config <path>     Additional user-controlled JSON configuration\n      --max-turns <n>      Maximum model turns per message\n  -y, --yes               Approve ordinary policy prompts, never sandbox exceptions\n  -v, --verbose           Show full non-sensitive tool output\n      --no-log            Do not write a local run record\n      --version           Show the installed package version\n  -h, --help              Show this help\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  output.write(`froe: ${message}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});

#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stderr as output, stdout } from "node:process";
import type { ReadStream, WriteStream } from "node:tty";
import { fileURLToPath } from "node:url";
import { formatActionDetails, formatApprovalPrompt, redactSensitiveText } from "./action-summary.js";
import { loadConfig } from "./config.js";
import { configureFroe } from "./core.js";
import { runConversation } from "./conversation.js";
import { DEFAULT_OPENAI_BASE_URL } from "./credentials.js";
import { openFroeSessionWithConfig } from "./session-composition.js";
import type { FroeApprovalPrompt, FroeSessionEvent, FroeSessionStatus } from "./session.js";
import { terminalMessages } from "./terminal-conversation.js";
import type { ApprovalDecision, McpServerConfig, ReasoningEffort, RunEvent, RunOptions } from "./types.js";
import { maybeAutoUpdate } from "./updater.js";

const reasoningValues = new Set<ReasoningEffort>(["none", "low", "medium", "high", "xhigh", "max"]);
const packageName = "@xfq/froe";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const packageVersion = await readPackageVersion();

interface ConfigureTavilyOptions {
  configureTavily: true;
}

interface RunCliOptions extends RunOptions {
  configureTavily: false;
}

type CliOptions = ConfigureTavilyOptions | RunCliOptions;

async function main(): Promise<void> {
  const mcpCommand = parseMcpCommand(process.argv.slice(2));
  if (mcpCommand !== undefined) {
    await configureFroe({ type: "add_mcp_server", name: mcpCommand.name, server: mcpCommand.server });
    output.write(`MCP server ${mcpCommand.name} added.\n`);
    return;
  }
  const options = await parseOptions();
  if (options.configureTavily) {
    await configureTavily();
    return;
  }
  const update = await maybeAutoUpdate({
    enabled: options.config.autoUpdate,
    packageName,
    packageRoot,
    currentVersion: packageVersion,
    onUpdateAvailable: (currentVersion, latestVersion) => {
      output.write(`Updating froe ${currentVersion} → ${latestVersion}...\n`);
    },
  });
  if (update.status === "updated") {
    output.write(`Updated froe to ${update.version}; the new version will be used on the next invocation.\n`);
  } else if (update.status === "failed") {
    output.write(`froe: automatic update ${update.phase} failed; continuing with ${packageVersion}.\n`);
  }
  const conversationMode = options.task === undefined;
  let render: (event: RunEvent) => void = () => undefined;
  const session = await openFroeSessionWithConfig({
    workspace: options.workspace,
    additionalDirectories: options.additionalDirectories,
    config: options.config,
    noLog: options.noLog,
    resumeHistory: conversationMode,
    approvalMode: options.yes ? "auto_non_destructive" : "prompt",
    ...(input.isTTY === true && output.isTTY === true
      ? {
        connectionPrompts: {
          promptApiKey: () => promptForApiKey(input, output),
          promptBaseURL: (defaultValue: string) => promptForBaseURL(input, output, defaultValue),
          onSaved: () => {
            output.write("OpenAI connection saved. Future runs will use it automatically.\n");
          },
        },
      }
      : {}),
    adapter: {
      onEvent: (envelope: FroeSessionEvent) => render(envelope.event),
      requestApproval: requestTerminalApproval,
    },
  });
  const status = session.status();
  render = createRenderer(options.verbose, status.recordPath, conversationMode);
  for (const failure of status.mcpFailures) output.write(`froe: MCP server ${failure.name} is unavailable: ${failure.message}\n`);
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
      printConversationBanner(status);
      await runConversation({
        session,
        messages: terminalMessages(input, output, controller.signal),
        imagePaths: options.imagePaths,
        signal: controller.signal,
        onModelSelected: (model) => {
          output.write(`froe conversation · ${model}\n`);
        },
        onResetConversation: async () => {
          await session.resetConversation?.();
          output.write("Conversation history cleared; starting fresh.\n");
        },
        showMcpServers: printMcpServers,
      });
      process.exitCode = controller.signal.aborted ? 130 : 0;
    } else {
      const outcome = await session.run({
        task: options.task,
        imagePaths: options.imagePaths,
        signal: controller.signal,
      });
      process.exitCode = outcome.status === "completed" ? 0 : outcome.status === "cancelled" ? 130 : 1;
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    await session.close();
  }
}

interface McpAddCommand {
  name: string;
  server: McpServerConfig;
}

function parseMcpCommand(args: string[]): McpAddCommand | undefined {
  if (args[0] !== "mcp") return undefined;
  const name = args[2];
  if (args[1] !== "add" || name === undefined) {
    throw new UsageError("Usage: froe mcp add <name> (-- <command> [args...] | --url <url>)");
  }
  if (args[3] === "--") {
    const command = args[4];
    if (command === undefined) throw new UsageError("Usage: froe mcp add <name> (-- <command> [args...] | --url <url>)");
    return { name, server: { command, args: args.slice(5) } };
  }
  if (args[3] === "--url" && args[4] !== undefined && args.length === 5) {
    return { name, server: { url: args[4] } };
  }
  throw new UsageError("Usage: froe mcp add <name> (-- <command> [args...] | --url <url>)");
}

async function parseOptions(): Promise<CliOptions> {
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
      "no-update": { type: "boolean", default: false },
      "configure-tavily": { type: "boolean", default: false },
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
  if (parsed.values["configure-tavily"]) {
    if (taskFromArguments) throw new UsageError("--configure-tavily does not accept a task.");
    return { configureTavily: true };
  }
  let task = taskFromArguments || undefined;
  if (task === undefined && input.isTTY !== true) task = (await taskFromStdin()).trim() || undefined;
  if (input.isTTY !== true && task === undefined) {
    throw new UsageError("Provide a task as positional text or pipe it through stdin.");
  }
  const workspace = resolve(stringOption(parsed.values.workspace) ?? process.cwd());
  const additionalDirectories = stringOptions(parsed.values["add-dir"]).map((path) => resolve(path));
  const reasoning = optionalReasoning(stringOption(parsed.values.reasoning));
  const imagePaths = stringOptions(parsed.values.image).map((path) => resolve(path));
  const maxTurns = optionalPositiveInteger(stringOption(parsed.values["max-turns"]), "--max-turns");
  const explicitConfigPath = stringOption(parsed.values.config);
  const config = await loadConfig({
    workspace,
    ...(explicitConfigPath === undefined ? {} : { configPath: explicitConfigPath }),
    overrides: {
      ...(parsed.values["no-update"] ? { autoUpdate: false } : {}),
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
    imagePaths,
    config,
    yes: Boolean(parsed.values.yes),
    verbose: Boolean(parsed.values.verbose),
    noLog: Boolean(parsed.values["no-log"]),
    configureTavily: false,
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
    "No OpenAI API key is configured.\nCreate one at https://platform.openai.com/api-keys\n",
  );
  return promptForHiddenText(terminalInput, terminalOutput, "OpenAI API key (input hidden): ", "Sign-in cancelled.");
}

async function configureTavily(): Promise<void> {
  if (input.isTTY !== true || output.isTTY !== true) {
    throw new UsageError("--configure-tavily requires an interactive terminal.");
  }
  const apiKey = await promptForHiddenText(input, output, "Tavily API key (input hidden): ", "Tavily configuration cancelled.");
  await configureFroe({ type: "save_tavily_api_key", apiKey });
  output.write("Tavily API key saved. Future runs will use it automatically.\n");
}

async function promptForHiddenText(
  terminalInput: ReadStream,
  terminalOutput: WriteStream,
  prompt: string,
  cancellationMessage: string,
): Promise<string> {
  terminalOutput.write(prompt);
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
          reject(new Error(cancellationMessage));
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

async function requestTerminalApproval(prompt: FroeApprovalPrompt, signal?: AbortSignal): Promise<ApprovalDecision> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return "deny";
  const readline = createInterface({ input, output });
  try {
    const choices = prompt.choices.includes("approve_for_run") ? "[y]es/[n]o/[a]ll this run" : "[y]es/[n]o";
    const message = formatApprovalPrompt(prompt.action, prompt.reason, choices);
    const answer = (signal === undefined
      ? await readline.question(message)
      : await readline.question(message, { signal })).trim().toLowerCase();
    if (answer === "a" && prompt.choices.includes("approve_for_run")) return "approve_for_run";
    return answer === "y" || answer === "yes" ? "approve_once" : "deny";
  } catch (error) {
    if (signal?.aborted) return "deny";
    throw error;
  } finally {
    readline.close();
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
        output.write(`→ ${event.action.name}\n`);
        writeActionDetails(event.action);
        break;
      case "approval_requested":
        output.write(`! approval needed: ${redactSensitiveText(event.reason)}\n`);
        writeActionDetails(event.action);
        break;
      case "action_result":
        output.write(`${event.result.ok ? "✓" : "✗"} ${event.result.name}${resultSuffix(event.result)}\n`);
        if (verbose) output.write(`${JSON.stringify(event.result.output, null, 2)}\n`);
        break;
      case "context_compacted":
        output.write(`↻ context compacted (${event.previousItems} → ${event.retainedItems} items)\n`);
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

function printConversationBanner(status: FroeSessionStatus): void {
  output.write(`froe conversation · ${status.config.model}\nworkspace: ${status.workspace}\n`);
  if (status.recordPath !== undefined) output.write(`record: ${status.recordPath}\n`);
  output.write("Send a follow-up after each run, type /mcp to list active servers, /new to start a fresh conversation, or type /exit to leave.\n");
}

function printMcpServers(status: FroeSessionStatus): void {
  if (status.activeMcpServers.length === 0) {
    output.write("No active MCP servers.\n");
    return;
  }
  output.write("Active MCP servers:\n");
  for (const server of status.activeMcpServers) output.write(`- ${server.name} (${server.toolCount} tools)\n`);
}

function writeActionDetails(action: { name: string; arguments: unknown }): void {
  for (const detail of formatActionDetails(action)) output.write(`  ${detail}\n`);
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
  output.write([
    "Usage: froe [options] [task...]",
    "",
    "Run without a task in an interactive terminal to start a conversation.",
    "",
    "Options:",
    "  -w, --workspace <path>  Workspace directory (default: current directory)",
    "      --add-dir <path>     Additional directory with read/write access (repeatable)",
    "      --base-url <url>     OpenAI-compatible API endpoint",
    "  -m, --model <id>        OpenAI-compatible model (default: gpt-5.6-terra)",
    "      --reasoning <level>  none, low, medium, high, xhigh, or max",
    "      --image <path>       Attach a PNG, JPEG, WEBP, or GIF to the first prompt (repeatable)",
    "  -c, --config <path>     Additional user-controlled JSON configuration",
    "      --max-turns <n>      Maximum model turns per message",
    "  -y, --yes               Approve ordinary policy prompts, never sandbox exceptions",
    "  -v, --verbose           Show full non-sensitive tool output",
    "      --no-log            Do not write a local run record",
    "      --no-update         Skip the automatic update check for this invocation",
    "      --configure-tavily  Save a Tavily API key in Froe's private credential file",
    "      --version           Show the installed package version",
    "  -h, --help              Show this help",
    "",
    "MCP commands:",
    "  froe mcp add <name> -- <command> [args...]",
    "                          Save a user-controlled stdio MCP server",
    "  froe mcp add <name> --url <url>",
    "                          Save a user-controlled remote MCP server",
    "",
  ].join("\n"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  output.write(`froe: ${message}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});

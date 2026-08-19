import { access, lstat, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { CommandSandboxError, type CommandSandbox, type SandboxException, type SandboxedCommandResult } from "./command-sandbox.js";
import type { ActionName, ActionRequest, ActionResult, FroeConfig, JsonValue, ToolDefinition } from "./types.js";

const ignoredDirectories = new Set([".git", "node_modules", "dist", ".froe"]);
const destructiveExecutables = new Set(["rm", "rmdir", "unlink", "shred", "mkfs", "dd", "sudo", "doas", "su"]);
const baseEnvironmentNames = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL"];
const maximumSandboxRetries = 3;

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "list_files",
    description: "List immediate non-symlink entries in a workspace directory.",
    parameters: objectSchema({
      path: optionalString("Workspace-relative directory, defaults to the workspace root."),
      maxEntries: optionalInteger("Maximum entries to return."),
    }),
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file by line range. Read a file before patching it.",
    parameters: objectSchema({
      path: requiredString("Workspace-relative file path."),
      startLine: optionalInteger("First one-based line, defaults to 1."),
      endLine: optionalInteger("Last one-based line, defaults to the configured maximum."),
    }, ["path"]),
  },
  {
    name: "search",
    description: "Perform a literal, case-sensitive text search over UTF-8 workspace files.",
    parameters: objectSchema({
      query: requiredString("Literal text to find."),
      path: optionalString("Workspace-relative file or directory, defaults to the root."),
      maxResults: optionalInteger("Maximum matches to return."),
    }, ["query"]),
  },
  {
    name: "apply_patch",
    description: "Apply an all-or-nothing batch of precise text replacements. Each oldText must occur exactly once. Use null oldText to create a file and null newText to delete a file.",
    parameters: objectSchema({
      changes: {
        type: "array",
        minItems: 1,
        items: objectSchema({
          path: requiredString("Workspace-relative text file path."),
          oldText: { type: ["string", "null"] },
          newText: { type: ["string", "null"] },
        }, ["path", "oldText", "newText"]),
      },
    }, ["changes"]),
  },
  {
    name: "run_command",
    description: "Run one executable with an argument array, never through an implicit shell. On macOS, commands automatically run without network access and may write only to the workspace and temporary directory; an OS-denied capability requires user approval before a narrow retry.",
    parameters: objectSchema({
      executable: requiredString("Program to execute."),
      args: { type: "array", items: { type: "string" } },
      cwd: optionalString("Workspace-relative working directory."),
      timeoutMs: optionalInteger("Timeout in milliseconds."),
    }, ["executable"]),
  },
  {
    name: "finish",
    description: "Explicitly end the run. completed needs a truthful change summary and validation evidence; blocked needs the concrete blocker.",
    parameters: objectSchema({
      outcome: { type: "string", enum: ["completed", "blocked"] },
      summary: requiredString("Concise outcome summary."),
      verification: {
        type: "array",
        items: objectSchema({
          description: requiredString("Check or reason."),
          result: { type: "string", enum: ["passed", "not_run", "failed"] },
        }, ["description", "result"]),
      },
    }, ["outcome", "summary", "verification"]),
  },
];

export interface ApprovalRequest {
  action: ActionRequest;
  reason: string;
  destructive: boolean;
  scope: "policy" | "sandbox_exception";
}

export interface ApprovalGate {
  request(request: ApprovalRequest): Promise<boolean>;
}

export interface ActionRuntimeHooks {
  onApprovalRequested?(request: ApprovalRequest): void | Promise<void>;
}

interface PatchChange {
  path: string;
  oldText: string | null;
  newText: string | null;
}

interface CommandAction {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export class ActionRuntime {
  readonly #workspace: string;
  readonly #config: FroeConfig;
  readonly #approval: ApprovalGate;
  readonly #commandSandbox: CommandSandbox;
  readonly #hooks: ActionRuntimeHooks;

  private constructor(workspace: string, config: FroeConfig, approval: ApprovalGate, commandSandbox: CommandSandbox, hooks: ActionRuntimeHooks) {
    this.#workspace = workspace;
    this.#config = config;
    this.#approval = approval;
    this.#commandSandbox = commandSandbox;
    this.#hooks = hooks;
  }

  static async create(
    workspace: string,
    config: FroeConfig,
    approval: ApprovalGate,
    commandSandbox: CommandSandbox,
    hooks: ActionRuntimeHooks = {},
  ): Promise<ActionRuntime> {
    const root = await realpath(workspace);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) throw new Error(`Workspace is not a directory: ${workspace}`);
    return new ActionRuntime(root, config, approval, commandSandbox, hooks);
  }

  get workspace(): string {
    return this.#workspace;
  }

  async execute(request: ActionRequest, signal?: AbortSignal): Promise<ActionResult> {
    try {
      switch (request.name) {
        case "list_files":
          return success(request, await this.listFiles(parseListArgs(request.arguments)));
        case "read_file":
          return success(request, await this.readFile(parseReadArgs(request.arguments)));
        case "search":
          return success(request, await this.search(parseSearchArgs(request.arguments)));
        case "apply_patch": {
          const changes = parsePatchArgs(request.arguments);
          await this.#requireApprovalIfNeeded(request, changes.some((change) => change.newText === null), changes.some((change) => change.newText === null) ? "Deleting a workspace file requires approval." : undefined);
          return success(request, await this.applyPatch(changes));
        }
        case "run_command": {
          const command = parseCommandArgs(request.arguments, this.#config.limits.commandTimeoutMs);
          const risk = commandRisk(command);
          await this.#requireApprovalIfNeeded(request, risk.requiresApproval, risk.reason, risk.destructive);
          return success(request, await this.runCommand(command, request, signal));
        }
        case "finish":
          return success(request, parseFinishArgs(request.arguments));
        default:
          return failure(request, "unknown_action", `Unknown action: ${request.name}`);
      }
    } catch (error) {
      const code = error instanceof ActionError || error instanceof CommandSandboxError ? error.code : "action_failed";
      return failure(request, code, error instanceof Error ? error.message : String(error));
    }
  }

  async #requireApprovalIfNeeded(
    request: ActionRequest,
    required: boolean,
    reason?: string,
    destructive = false,
    scope: ApprovalRequest["scope"] = "policy",
  ): Promise<void> {
    if (!required) return;
    const approvalRequest: ApprovalRequest = { action: request, reason: reason ?? "This action requires approval.", destructive, scope };
    await this.#hooks.onApprovalRequested?.(approvalRequest);
    if (!await this.#approval.request(approvalRequest)) {
      throw new ActionError("approval_denied", `Approval was denied: ${approvalRequest.reason}`);
    }
  }

  async listFiles(args: { path: string; maxEntries: number }): Promise<JsonValue> {
    const directory = await this.resolveExisting(args.path);
    const directoryStat = await stat(directory);
    if (!directoryStat.isDirectory()) throw new ActionError("not_directory", `${args.path} is not a directory`);
    const entries = await readdir(directory, { withFileTypes: true });
    const visible = entries
      .filter((entry) => !entry.isSymbolicLink())
      .filter((entry) => !ignoredDirectories.has(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    const shown = visible.slice(0, args.maxEntries);
    return {
      path: this.toRelative(directory),
      entries: shown.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" })),
      truncated: visible.length > shown.length,
    };
  }

  async readFile(args: { path: string; startLine: number; endLine?: number }): Promise<JsonValue> {
    const path = await this.resolveExisting(args.path);
    const fileStat = await stat(path);
    if (!fileStat.isFile()) throw new ActionError("not_file", `${args.path} is not a file`);
    const content = await this.readText(path);
    const lines = content.text.split(/\r?\n/);
    const startLine = Math.min(args.startLine, Math.max(1, lines.length));
    const requestedEnd = args.endLine ?? startLine + this.#config.limits.readLines - 1;
    let endLine = Math.min(requestedEnd, startLine + this.#config.limits.readLines - 1, lines.length);
    let selected = lines.slice(startLine - 1, endLine);
    let text = selected.join(content.newline);
    let truncated = endLine < lines.length;
    if (Buffer.byteLength(text) > this.#config.limits.readBytes) {
      const clipped: string[] = [];
      let size = 0;
      for (const line of selected) {
        const next = Buffer.byteLength(line + content.newline);
        if (size + next > this.#config.limits.readBytes) break;
        clipped.push(line);
        size += next;
      }
      selected = clipped;
      text = selected.join(content.newline);
      endLine = startLine + selected.length - 1;
      truncated = true;
    }
    return {
      path: this.toRelative(path),
      startLine,
      endLine,
      totalLines: lines.length,
      text,
      truncated,
    };
  }

  async search(args: { query: string; path: string; maxResults: number }): Promise<JsonValue> {
    const target = await this.resolveExisting(args.path);
    const ripgrepResult = await this.searchWithRipgrep(args, target);
    if (ripgrepResult !== undefined) return ripgrepResult;
    return this.searchWithNode(args, target);
  }

  async searchWithNode(args: { query: string; path: string; maxResults: number }, target: string): Promise<JsonValue> {
    const results: JsonValue[] = [];
    let skippedBinary = 0;
    const visit = async (path: string): Promise<void> => {
      if (results.length >= args.maxResults) return;
      const itemStat = await lstat(path);
      if (itemStat.isSymbolicLink()) return;
      if (itemStat.isDirectory()) {
        const entries = await readdir(path, { withFileTypes: true });
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          if (ignoredDirectories.has(entry.name) || entry.isSymbolicLink()) continue;
          await visit(join(path, entry.name));
          if (results.length >= args.maxResults) break;
        }
        return;
      }
      if (!itemStat.isFile() || itemStat.size > 2 * 1024 * 1024) return;
      let text: string;
      try {
        text = (await this.readText(path)).text;
      } catch (error) {
        if (error instanceof ActionError && error.code === "binary_file") skippedBinary += 1;
        return;
      }
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (!line.includes(args.query)) continue;
        results.push({ path: this.toRelative(path), line: index + 1, text: line.slice(0, 500) });
        if (results.length >= args.maxResults) break;
      }
    };
    await visit(target);
    return { query: args.query, results, truncated: results.length >= args.maxResults, skippedBinary };
  }

  async searchWithRipgrep(args: { query: string; path: string; maxResults: number }, target: string): Promise<JsonValue | undefined> {
    let result: SandboxedCommandResult;
    try {
      result = await this.#commandSandbox.run({
        executable: "rg",
        args: [
        "--json",
        "--fixed-strings",
        "--line-number",
        "--hidden",
        "--glob", "!.git/**",
        "--glob", "!node_modules/**",
        "--glob", "!dist/**",
        "--glob", "!.froe/**",
        "--",
        args.query,
        target,
        ],
        cwd: this.#workspace,
        env: this.commandEnvironment(),
        timeoutMs: this.#config.limits.commandTimeoutMs,
        maxOutputBytes: Math.max(this.#config.limits.readBytes * 4, 128 * 1024),
      });
    } catch {
      return undefined;
    }
    if (result.denial !== undefined || result.timedOut || (result.exitCode !== 0 && result.exitCode !== 1 && result.exitCode !== null)) return undefined;
    const results: JsonValue[] = [];
    for (const line of result.output.split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } };
        if (event.type !== "match" || event.data?.path?.text === undefined || event.data.lines?.text === undefined || event.data.line_number === undefined) continue;
        const path = resolve(event.data.path.text);
        this.assertInside(path, event.data.path.text);
        results.push({
          path: this.toRelative(path),
          line: event.data.line_number,
          text: event.data.lines.text.replace(/\r?\n$/, "").slice(0, 500),
        });
        if (results.length >= args.maxResults) break;
      } catch {
        return undefined;
      }
    }
    return { query: args.query, results, truncated: results.length >= args.maxResults, skippedBinary: 0 };
  }

  async applyPatch(changes: PatchChange[]): Promise<JsonValue> {
    const paths = new Set<string>();
    for (const change of changes) {
      if (paths.has(change.path)) throw new ActionError("duplicate_path", `A patch may only change ${change.path} once`);
      paths.add(change.path);
    }

    const prepared: Array<{ change: PatchChange; path: string; content: string | null; original: string | null; mode?: number }> = [];
    for (const change of changes) {
      const exists = await this.pathExists(change.path);
      if (change.oldText === null) {
        if (change.newText === null) throw new ActionError("invalid_patch", `${change.path} cannot have both oldText and newText as null`);
        if (exists) throw new ActionError("file_exists", `${change.path} already exists`);
        prepared.push({ change, path: await this.resolveCandidate(change.path), content: change.newText, original: null });
        continue;
      }
      if (!exists) throw new ActionError("file_missing", `${change.path} does not exist`);
      const path = await this.resolveExisting(change.path);
      const fileStat = await stat(path);
      if (!fileStat.isFile()) throw new ActionError("not_file", `${change.path} is not a file`);
      const existing = await this.readText(path);
      const occurrences = countOccurrences(existing.text, change.oldText);
      if (occurrences !== 1) throw new ActionError("patch_mismatch", `${change.path} oldText must occur exactly once; found ${occurrences}`);
      if (change.newText === null && existing.text !== change.oldText) {
        throw new ActionError("delete_requires_full_match", `Deleting ${change.path} requires oldText to equal the full file`);
      }
      prepared.push({
        change,
        path,
        content: change.newText === null ? null : existing.text.replace(change.oldText, change.newText),
        original: existing.text,
        mode: fileStat.mode,
      });
    }

    const temporaryPaths = new Map<string, string>();
    const applied: typeof prepared = [];
    try {
      for (const item of prepared) {
        if (item.content === null) continue;
        await mkdir(dirname(item.path), { recursive: true });
        const temporary = join(dirname(item.path), `.${basename(item.path)}.${randomUUID()}.froe-tmp`);
        temporaryPaths.set(item.path, temporary);
        await writeFile(temporary, item.content, item.mode === undefined ? undefined : { mode: item.mode });
      }
      for (const item of prepared) {
        if (item.content === null) {
          await unlink(item.path);
          applied.push(item);
          continue;
        }
        const temporary = temporaryPaths.get(item.path);
        if (temporary === undefined) throw new Error("Internal patch staging error");
        await rename(temporary, item.path);
        temporaryPaths.delete(item.path);
        applied.push(item);
      }
    } catch (error) {
      for (const item of [...applied].reverse()) {
        try {
          if (item.original === null) await unlink(item.path);
          else await writeFile(item.path, item.original, item.mode === undefined ? undefined : { mode: item.mode });
        } catch {
          // Preserve the original error; this best-effort rollback is recorded by the caller's failed action result.
        }
      }
      throw error;
    } finally {
      await Promise.all([...temporaryPaths.values()].map(async (path) => unlink(path).catch(() => undefined)));
    }
    return { changed: changes.map((change) => ({ path: change.path, operation: change.oldText === null ? "created" : change.newText === null ? "deleted" : "replaced" })) };
  }

  async runCommand(command: CommandAction, request: ActionRequest, signal?: AbortSignal): Promise<JsonValue> {
    const cwd = await this.resolveExisting(command.cwd);
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) throw new ActionError("not_directory", `${command.cwd} is not a directory`);
    const invocation = {
      executable: command.executable,
      args: command.args,
      cwd,
      env: this.commandEnvironment(),
      timeoutMs: command.timeoutMs,
      maxOutputBytes: this.#config.limits.commandOutputBytes,
      ...(signal === undefined ? {} : { signal }),
    };
    const exceptions: SandboxException[] = [];
    let result = await this.#commandSandbox.run(invocation);
    for (let retry = 0; result.denial !== undefined && retry < maximumSandboxRetries; retry += 1) {
      const additions = newSandboxExceptions(exceptions, result.denial.exceptions);
      if (additions.length === 0) throw new ActionError("command_sandbox_blocked", `${result.denial.reason} Froe could not construct a narrow retry exception.`);
      const retryReason = `${result.denial.reason} Approve ${describeSandboxExceptions(additions)} and rerun the command once? The previous attempt may already have changed files inside the workspace.`;
      await this.#requireApprovalIfNeeded(request, true, retryReason, result.denial.destructive, "sandbox_exception");
      exceptions.push(...additions);
      result = await this.#commandSandbox.run(invocation, exceptions);
    }
    if (result.denial !== undefined) {
      throw new ActionError("command_sandbox_blocked", `${result.denial.reason} The command remained blocked after ${maximumSandboxRetries} narrow retries.`);
    }
    return {
      executable: command.executable,
      args: command.args,
      cwd: this.toRelative(cwd),
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      output: result.output,
      truncated: result.truncated,
      sandboxed: true,
      sandboxExceptions: exceptions.map(sandboxExceptionOutput),
    };
  }

  async resolveExisting(input: string): Promise<string> {
    const path = await this.resolveCandidate(input);
    try {
      await access(path);
    } catch {
      throw new ActionError("path_missing", `${input} does not exist`);
    }
    const item = await lstat(path);
    if (item.isSymbolicLink()) throw new ActionError("symlink_forbidden", `${input} is a symbolic link`);
    const resolved = await realpath(path);
    this.assertInside(resolved, input);
    return resolved;
  }

  async resolveCandidate(input: string): Promise<string> {
    if (!input || isAbsolute(input)) throw new ActionError("invalid_path", "Paths must be non-empty and workspace-relative");
    const normalized = resolve(this.#workspace, input);
    this.assertInside(normalized, input);
    const suffix = relative(this.#workspace, normalized).split(sep).filter(Boolean);
    let current = this.#workspace;
    for (const part of suffix) {
      current = join(current, part);
      try {
        const item = await lstat(current);
        if (item.isSymbolicLink()) throw new ActionError("symlink_forbidden", `Path contains a symbolic link: ${input}`);
      } catch (error) {
        if (error instanceof ActionError) throw error;
        break;
      }
    }
    return normalized;
  }

  async pathExists(input: string): Promise<boolean> {
    try {
      await access(await this.resolveCandidate(input));
      return true;
    } catch (error) {
      if (error instanceof ActionError) throw error;
      return false;
    }
  }

  async readText(path: string): Promise<{ text: string; newline: "\n" | "\r\n" }> {
    const buffer = await readFile(path);
    if (buffer.includes(0)) throw new ActionError("binary_file", `${this.toRelative(path)} appears to be binary`);
    const text = buffer.toString("utf8");
    if (text.includes("\uFFFD")) throw new ActionError("non_utf8", `${this.toRelative(path)} is not valid UTF-8 text`);
    return { text, newline: text.includes("\r\n") ? "\r\n" : "\n" };
  }

  commandEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const name of [...baseEnvironmentNames, ...this.#config.commandEnv]) {
      const value = process.env[name];
      if (value !== undefined && name !== "OPENAI_API_KEY") environment[name] = value;
    }
    return environment;
  }

  toRelative(path: string): string {
    return relative(this.#workspace, path) || ".";
  }

  assertInside(path: string, original: string): void {
    const value = relative(this.#workspace, path);
    if (value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))) return;
    throw new ActionError("workspace_escape", `Path escapes the workspace: ${original}`);
  }
}

class ActionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function success(request: ActionRequest, output: JsonValue): ActionResult {
  return { callId: request.callId, name: request.name, ok: true, output };
}

function failure(request: ActionRequest, code: string, message: string): ActionResult {
  return { callId: request.callId, name: request.name, ok: false, output: { code, message } };
}

function parseListArgs(value: unknown): { path: string; maxEntries: number } {
  const object = argumentObject(value);
  return { path: optionalStringValue(object.path, "path") ?? ".", maxEntries: optionalPositiveInteger(object.maxEntries, "maxEntries") ?? 200 };
}

function parseReadArgs(value: unknown): { path: string; startLine: number; endLine?: number } {
  const object = argumentObject(value);
  const endLine = optionalPositiveInteger(object.endLine, "endLine");
  const startLine = optionalPositiveInteger(object.startLine, "startLine") ?? 1;
  if (endLine !== undefined && endLine < startLine) throw new ActionError("invalid_arguments", "endLine must not precede startLine");
  return { path: requiredStringValue(object.path, "path"), startLine, ...(endLine === undefined ? {} : { endLine }) };
}

function parseSearchArgs(value: unknown): { query: string; path: string; maxResults: number } {
  const object = argumentObject(value);
  return {
    query: requiredStringValue(object.query, "query"),
    path: optionalStringValue(object.path, "path") ?? ".",
    maxResults: optionalPositiveInteger(object.maxResults, "maxResults") ?? 200,
  };
}

function parsePatchArgs(value: unknown): PatchChange[] {
  const object = argumentObject(value);
  if (!Array.isArray(object.changes) || object.changes.length === 0) throw new ActionError("invalid_arguments", "changes must be a non-empty array");
  return object.changes.map((item, index) => {
    const change = argumentObject(item);
    const oldText = nullableStringValue(change.oldText, `changes[${index}].oldText`);
    const newText = nullableStringValue(change.newText, `changes[${index}].newText`);
    if (oldText === null && newText === null) throw new ActionError("invalid_arguments", `changes[${index}] cannot have both texts null`);
    return { path: requiredStringValue(change.path, `changes[${index}].path`), oldText, newText };
  });
}

function parseCommandArgs(value: unknown, defaultTimeout: number): CommandAction {
  const object = argumentObject(value);
  const rawArgs = object.args;
  if (rawArgs !== undefined && (!Array.isArray(rawArgs) || rawArgs.some((arg) => typeof arg !== "string"))) {
    throw new ActionError("invalid_arguments", "args must be an array of strings");
  }
  return {
    executable: requiredStringValue(object.executable, "executable"),
    args: rawArgs === undefined ? [] : [...rawArgs] as string[],
    cwd: optionalStringValue(object.cwd, "cwd") ?? ".",
    timeoutMs: optionalPositiveInteger(object.timeoutMs, "timeoutMs") ?? defaultTimeout,
  };
}

function parseFinishArgs(value: unknown): JsonValue {
  const object = argumentObject(value);
  const outcome = requiredStringValue(object.outcome, "outcome");
  if (outcome !== "completed" && outcome !== "blocked") throw new ActionError("invalid_arguments", "outcome must be completed or blocked");
  if (!Array.isArray(object.verification)) throw new ActionError("invalid_arguments", "verification must be an array");
  const verification = object.verification.map((item, index) => {
    const entry = argumentObject(item);
    const result = requiredStringValue(entry.result, `verification[${index}].result`);
    if (result !== "passed" && result !== "not_run" && result !== "failed") throw new ActionError("invalid_arguments", "verification result is invalid");
    return { description: requiredStringValue(entry.description, `verification[${index}].description`), result };
  });
  return { outcome, summary: requiredStringValue(object.summary, "summary"), verification };
}

function commandRisk(command: CommandAction): { requiresApproval: boolean; destructive: boolean; reason?: string } {
  const executable = basename(command.executable);
  if (destructiveExecutables.has(executable)) return { requiresApproval: true, destructive: true, reason: `${executable} is potentially destructive.` };
  if (executable === "git" && ["reset", "clean", "restore", "checkout"].includes(command.args[0] ?? "")) {
    return { requiresApproval: true, destructive: true, reason: `git ${command.args[0]} can discard workspace changes.` };
  }
  return { requiresApproval: false, destructive: false };
}

function newSandboxExceptions(current: SandboxException[], proposed: SandboxException[]): SandboxException[] {
  const existing = new Set(current.map(sandboxExceptionKey));
  return proposed.filter((exception) => !existing.has(sandboxExceptionKey(exception)));
}

function sandboxExceptionKey(exception: SandboxException): string {
  return exception.type === "file-write" ? `file-write\0${exception.path}` : `network\0${exception.operation}\0${exception.target}`;
}

function describeSandboxExceptions(exceptions: SandboxException[]): string {
  return exceptions.map((exception) => exception.type === "file-write"
    ? `write access to exactly ${exception.path}`
    : `${exception.operation} access to ${exception.target}`).join(" and ");
}

function sandboxExceptionOutput(exception: SandboxException): JsonValue {
  return exception.type === "file-write"
    ? { type: exception.type, path: exception.path }
    : { type: exception.type, operation: exception.operation, target: exception.target };
}

function countOccurrences(text: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = text.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

function argumentObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ActionError("invalid_arguments", "Action arguments must be an object");
  return value as Record<string, unknown>;
}

function requiredStringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new ActionError("invalid_arguments", `${name} must be a non-empty string`);
  return value;
}

function optionalStringValue(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredStringValue(value, name);
}

function nullableStringValue(value: unknown, name: string): string | null {
  if (value === null) return null;
  return requiredStringValue(value, name);
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new ActionError("invalid_arguments", `${name} must be a positive integer`);
  return value;
}

function objectSchema(properties: Record<string, JsonValue>, required: string[] = []): { [key: string]: JsonValue } {
  return { type: "object", additionalProperties: false, properties, ...(required.length === 0 ? {} : { required }) };
}

function requiredString(description: string): { [key: string]: JsonValue } {
  return { type: "string", description };
}

function optionalString(description: string): { [key: string]: JsonValue } {
  return { type: "string", description };
}

function optionalInteger(description: string): { [key: string]: JsonValue } {
  return { type: "integer", minimum: 1, description };
}

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";

const sandboxExecutable = "/usr/bin/sandbox-exec";
const logExecutable = "/usr/bin/log";
const monitorReadyText = "Filtering the log data";
const monitorStartupTimeoutMs = 2_000;
const violationFlushMs = 150;
const diagnosticBytes = 16 * 1024;
const supportedNetworkOperations = new Set([
  "network-bind",
  "network-channel",
  "network-client",
  "network-inbound",
  "network-outbound",
  "network-server",
]);

export interface CommandInvocation {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export type SandboxException =
  | { type: "file-write"; path: string }
  | { type: "network"; operation: string; target: string };

export interface SandboxViolation {
  operation: string;
  target?: string;
}

export interface SandboxDenial {
  violations: SandboxViolation[];
  exceptions: SandboxException[];
  reason: string;
  destructive: boolean;
}

export interface SandboxedCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  output: string;
  truncated: boolean;
  denial?: SandboxDenial;
}

export interface CommandSandbox {
  run(command: CommandInvocation, exceptions?: SandboxException[]): Promise<SandboxedCommandResult>;
}

export class CommandSandboxError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export async function createCommandSandbox(workspace: string): Promise<CommandSandbox> {
  if (process.platform !== "darwin") return new UnavailableCommandSandbox(process.platform);
  return MacOSSeatbeltCommandSandbox.create(workspace);
}

export class MacOSSeatbeltCommandSandbox implements CommandSandbox {
  readonly #workspace: string;
  readonly #temporaryDirectory: string;

  private constructor(workspace: string, temporaryDirectory: string) {
    this.#workspace = workspace;
    this.#temporaryDirectory = temporaryDirectory;
  }

  static async create(workspace: string, temporaryDirectory = tmpdir()): Promise<MacOSSeatbeltCommandSandbox> {
    await Promise.all([access(sandboxExecutable), access(logExecutable)]);
    return new MacOSSeatbeltCommandSandbox(await realpath(workspace), await realpath(temporaryDirectory));
  }

  async run(command: CommandInvocation, exceptions: SandboxException[] = []): Promise<SandboxedCommandResult> {
    const marker = `FROE_SANDBOX_${randomUUID().replaceAll("-", "")}`;
    const monitor = await startViolationMonitor(marker);
    let result: CapturedProcessResult;
    try {
      result = await captureProcess({
        executable: sandboxExecutable,
        args: ["-p", seatbeltProfile(this.#workspace, this.#temporaryDirectory, marker, exceptions), command.executable, ...command.args],
        cwd: command.cwd,
        env: { ...command.env, TMPDIR: this.#temporaryDirectory },
        timeoutMs: command.timeoutMs,
        maxOutputBytes: command.maxOutputBytes,
        ...(command.signal === undefined ? {} : { signal: command.signal }),
      });
    } catch (error) {
      await monitor.finish();
      throw error;
    }
    // The monitor stays alive until the kernel has published any denial generated during process exit.
    const violations = await monitor.finish();
    if (result.exitCode !== 0 && result.diagnostics.includes("sandbox-exec: sandbox_apply:")) {
      throw new CommandSandboxError("command_sandbox_failed", result.diagnostics.trim());
    }
    const startFailure = /sandbox-exec: execvp\(\)(?: of '[^']+')?(?: failed)?: ([^\n]+)/.exec(result.diagnostics);
    if (result.exitCode !== 0 && startFailure?.[1] !== undefined) {
      throw new CommandSandboxError("command_start_failed", startFailure[1]);
    }
    const denial = denialFromViolations(violations);
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      output: result.output,
      truncated: result.truncated,
      ...(denial === undefined ? {} : { denial }),
    };
  }
}

class UnavailableCommandSandbox implements CommandSandbox {
  constructor(private readonly platform: NodeJS.Platform) {}

  async run(_command: CommandInvocation, _exceptions: SandboxException[] = []): Promise<SandboxedCommandResult> {
    throw new CommandSandboxError(
      "command_sandbox_unavailable",
      `Command execution is disabled because Froe has no operating-system sandbox for ${this.platform}.`,
    );
  }
}

interface CapturedProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  output: string;
  truncated: boolean;
  diagnostics: string;
}

interface ViolationMonitor {
  finish(): Promise<SandboxViolation[]>;
}

async function startViolationMonitor(marker: string): Promise<ViolationMonitor> {
  const monitor = spawn(logExecutable, [
    "stream",
    "--style", "ndjson",
    "--predicate", `eventMessage CONTAINS ${profileString(marker)}`,
  ], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  let ready = false;
  let finished = false;
  let stopping = false;
  let monitorFailure: CommandSandboxError | undefined;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const closePromise = new Promise<void>((resolve) => {
    monitor.once("close", () => resolve());
  });
  const append = (chunk: Buffer): void => {
    text += chunk.toString("utf8");
    if (!ready && text.includes(monitorReadyText)) {
      ready = true;
      resolveReady?.();
    }
  };
  monitor.stdout.on("data", append);
  monitor.stderr.on("data", append);
  monitor.once("error", (error) => {
    monitorFailure = new CommandSandboxError("command_sandbox_monitor_failed", error.message);
    if (!ready) rejectReady?.(monitorFailure);
  });
  monitor.once("close", (code) => {
    if (!stopping && monitorFailure === undefined) {
      monitorFailure = new CommandSandboxError("command_sandbox_monitor_failed", `Seatbelt log monitor exited unexpectedly with code ${String(code)}.`);
    }
    if (!ready && monitorFailure !== undefined) rejectReady?.(monitorFailure);
  });

  let startupTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      readyPromise,
      new Promise<never>((_resolve, reject) => {
        startupTimer = setTimeout(() => reject(new CommandSandboxError("command_sandbox_monitor_failed", "Timed out while starting the Seatbelt log monitor.")), monitorStartupTimeoutMs);
      }),
    ]);
  } catch (error) {
    monitor.kill("SIGTERM");
    await closePromise;
    throw error;
  } finally {
    if (startupTimer !== undefined) clearTimeout(startupTimer);
  }

  return {
    async finish(): Promise<SandboxViolation[]> {
      if (finished) return parseViolations(text, marker);
      finished = true;
      await new Promise((resolve) => setTimeout(resolve, violationFlushMs));
      stopping = true;
      if (monitor.exitCode === null && monitor.signalCode === null) monitor.kill("SIGTERM");
      await closePromise;
      if (monitorFailure !== undefined) throw monitorFailure;
      return parseViolations(text, marker);
    },
  };
}

function captureProcess(command: CommandInvocation): Promise<CapturedProcessResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    const diagnostics: Buffer[] = [];
    let outputBytes = 0;
    let diagnosticByteCount = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer): void => {
      if (diagnosticByteCount < diagnosticBytes) {
        const diagnosticChunk = chunk.subarray(0, diagnosticBytes - diagnosticByteCount);
        diagnostics.push(diagnosticChunk);
        diagnosticByteCount += diagnosticChunk.length;
      }
      if (outputBytes >= command.maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = command.maxOutputBytes - outputBytes;
      const accepted = chunk.subarray(0, remaining);
      output.push(accepted);
      outputBytes += accepted.length;
      if (accepted.length < chunk.length) truncated = true;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, command.timeoutMs);
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    command.signal?.addEventListener("abort", onAbort, { once: true });
    if (command.signal?.aborted) onAbort();
    child.once("error", (error) => {
      cleanup();
      if (settled) return;
      settled = true;
      rejectResult(new CommandSandboxError("command_start_failed", error.message));
    });
    child.once("close", (code, terminationSignal) => {
      cleanup();
      if (settled) return;
      settled = true;
      resolveResult({
        exitCode: code,
        signal: terminationSignal,
        timedOut,
        output: Buffer.concat(output).toString("utf8"),
        truncated,
        diagnostics: Buffer.concat(diagnostics).toString("utf8"),
      });
    });
    const cleanup = (): void => {
      clearTimeout(timer);
      command.signal?.removeEventListener("abort", onAbort);
    };
  });
}

function seatbeltProfile(workspace: string, temporaryDirectory: string, marker: string, exceptions: SandboxException[]): string {
  const rules = [
    "(version 1)",
    "(allow default)",
    `(deny network* (with message ${profileString(marker)}))`,
    `(deny file-write* (with message ${profileString(marker)}))`,
    `(allow file-write* (subpath ${profileString(workspace)}))`,
    `(allow file-write* (subpath ${profileString(temporaryDirectory)}))`,
    '(allow file-write-data (literal "/dev/dtracehelper") (literal "/dev/null"))',
  ];
  for (const exception of uniqueExceptions(exceptions)) {
    if (exception.type === "file-write") {
      if (!isAbsolute(exception.path)) throw new CommandSandboxError("invalid_sandbox_exception", "File-write sandbox exceptions must be absolute paths.");
      rules.push(`(allow file-write* (literal ${profileString(exception.path)}) (subpath ${profileString(exception.path)}))`);
      continue;
    }
    if (!supportedNetworkOperations.has(exception.operation)) {
      throw new CommandSandboxError("invalid_sandbox_exception", `Unsupported network sandbox exception: ${exception.operation}`);
    }
    const networkTarget = parseNetworkTarget(exception.target);
    if (networkTarget === undefined) {
      throw new CommandSandboxError("invalid_sandbox_exception", `Unsupported network sandbox target: ${exception.target}`);
    }
    rules.push(`(allow ${exception.operation} (${networkTarget.direction} ip ${profileString(networkTarget.address)}))`);
  }
  return `${rules.join("\n")}\n`;
}

function profileString(value: string): string {
  return JSON.stringify(value);
}

function parseViolations(text: string, marker: string): SandboxViolation[] {
  const violations: SandboxViolation[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as { eventMessage?: unknown };
      if (typeof event.eventMessage !== "string" || !event.eventMessage.includes(marker)) continue;
      const match = /^Sandbox: .+ deny\(\d+\) ([a-zA-Z0-9*-]+)(?: (.*))?\n/.exec(event.eventMessage);
      if (match?.[1] === undefined) continue;
      violations.push({ operation: match[1], ...(match[2] === undefined ? {} : { target: match[2] }) });
    } catch {
      // Ignore the monitor's non-JSON prelude and incomplete final lines.
    }
  }
  return uniqueViolations(violations);
}

function denialFromViolations(violations: SandboxViolation[]): SandboxDenial | undefined {
  if (violations.length === 0) return undefined;
  const exceptions: SandboxException[] = [];
  for (const violation of violations) {
    if (violation.operation.startsWith("file-write") && violation.target !== undefined && isAbsolute(violation.target)) {
      exceptions.push({ type: "file-write", path: violation.target });
    } else if (supportedNetworkOperations.has(violation.operation) && violation.target !== undefined && parseNetworkTarget(violation.target) !== undefined) {
      exceptions.push({ type: "network", operation: violation.operation, target: violation.target });
    }
  }
  const details = violations.slice(0, 4).map((violation) => `${violation.operation}${violation.target === undefined ? "" : ` ${violation.target}`}`);
  const remainder = violations.length - details.length;
  const reason = `macOS blocked ${details.join(", ")}${remainder === 0 ? "" : ` and ${remainder} more operation${remainder === 1 ? "" : "s"}`}.`;
  return {
    violations,
    exceptions: uniqueExceptions(exceptions),
    reason,
    destructive: violations.some((violation) => violation.operation.startsWith("file-write")),
  };
}

function uniqueViolations(violations: SandboxViolation[]): SandboxViolation[] {
  const seen = new Set<string>();
  return violations.filter((violation) => {
    const key = `${violation.operation}\0${violation.target ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueExceptions(exceptions: SandboxException[]): SandboxException[] {
  const seen = new Set<string>();
  return exceptions.filter((exception) => {
    const key = exception.type === "file-write" ? `file-write\0${exception.path}` : `network\0${exception.operation}\0${exception.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseNetworkTarget(target: string): { direction: "local" | "remote"; address: string } | undefined {
  const match = /^(local|remote):(.+)$/.exec(target);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { direction: match[1] as "local" | "remote", address: match[2] };
}

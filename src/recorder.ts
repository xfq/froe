import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { formatActionDetails, redactSensitiveText } from "./action-summary.js";
import type { LogMode, RunEvent } from "./types.js";

export class RunRecorder {
  readonly #path: string | undefined;
  readonly #mode: LogMode;

  private constructor(path: string | undefined, mode: LogMode) {
    this.#path = path;
    this.#mode = mode;
  }

  static async create(mode: LogMode, disabled: boolean): Promise<RunRecorder> {
    if (disabled) return new RunRecorder(undefined, mode);
    const root = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    const directory = join(root, "froe", "runs");
    await mkdir(directory, { recursive: true });
    return new RunRecorder(join(directory, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.jsonl`), mode);
  }

  get path(): string | undefined {
    return this.#path;
  }

  async record(event: RunEvent): Promise<void> {
    if (this.#path === undefined) return;
    const payload = this.#mode === "full" ? event : metadataEvent(event);
    await appendFile(this.#path, `${JSON.stringify({ at: new Date().toISOString(), event: payload })}\n`);
  }
}

function metadataEvent(event: RunEvent): object {
  switch (event.type) {
    case "run_started":
      return event;
    case "model_text":
      return { type: event.type, characters: event.text.length };
    case "action_requested":
      return { type: event.type, callId: event.action.callId, name: event.action.name, summary: formatActionDetails(event.action) };
    case "action_result":
      return { type: event.type, callId: event.result.callId, name: event.result.name, ok: event.result.ok, result: resultMetadata(event.result.name, event.result.output) };
    case "approval_requested":
      return { type: event.type, name: event.action.name, summary: formatActionDetails(event.action), reason: redactSensitiveText(event.reason) };
    case "context_compacted":
      return event;
    case "usage":
      return event;
    case "run_finished":
      return event;
  }
}

function resultMetadata(name: string, value: unknown): object {
  if (!isRecord(value)) return {};
  if (name === "run_command") return { exitCode: value.exitCode, timedOut: value.timedOut, truncated: value.truncated };
  if (name === "apply_patch") return { changed: value.changed };
  if (name === "read_file") return { path: value.path, startLine: value.startLine, endLine: value.endLine, truncated: value.truncated };
  if (name === "search") return { query: value.query, matchCount: Array.isArray(value.results) ? value.results.length : undefined, truncated: value.truncated };
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

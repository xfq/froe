import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { JsonValue } from "./types.js";

const HISTORY_FORMAT_VERSION = 1 as const;
const supportedItemTypes = new Set(["message", "function_call", "function_call_output", "compaction", "reasoning"]);
const supportedRoles = new Set(["user", "assistant", "system", "developer"]);

interface StoredHistoryFile {
  version: typeof HISTORY_FORMAT_VERSION;
  workspace: string;
  items: JsonValue[];
}

/**
 * Persists one workspace's model continuation items as an owner-only JSON
 * file under the user state directory, keyed by a hash of the workspace path.
 *
 * The file lives outside the workspace on purpose: continuation items include
 * source-bearing tool output and model text, so they must not enter the user's
 * repository. It is not a run record; it is the state that lets the next
 * interactive invocation resume a conversation.
 */
export class ConversationHistoryStore {
  readonly #path: string;
  readonly #workspace: string;

  private constructor(path: string, workspace: string) {
    this.#path = path;
    this.#workspace = workspace;
  }

  static forWorkspace(workspace: string): ConversationHistoryStore {
    const root = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    const directory = join(root, "froe", "conversations");
    const hash = createHash("sha256").update(workspace).digest("hex");
    return new ConversationHistoryStore(join(directory, `${hash}.json`), workspace);
  }

  get path(): string {
    return this.#path;
  }

  /**
   * Loads the persisted items, or returns an empty array when no usable
   * history exists. Missing, unreadable, or malformed files deliberately
   * start a fresh conversation instead of blocking session startup.
   */
  async load(): Promise<JsonValue[]> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!isRecord(parsed) || parsed.version !== HISTORY_FORMAT_VERSION || parsed.workspace !== this.#workspace) {
      return [];
    }
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items.filter(isSupportedHistoryItem);
  }

  async save(items: readonly JsonValue[]): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const payload: StoredHistoryFile = {
      version: HISTORY_FORMAT_VERSION,
      workspace: this.#workspace,
      items: [...items],
    };
    const temporaryPath = join(dirname(this.#path), `.conversation.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
      if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.#path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.#path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  }
}

function isSupportedHistoryItem(value: unknown): value is JsonValue {
  if (!isRecord(value)) return false;
  if (typeof value.type === "string" && supportedItemTypes.has(value.type)) return true;
  return (
    typeof value.role === "string"
    && supportedRoles.has(value.role)
    && (value.content === undefined || typeof value.content === "string" || Array.isArray(value.content))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

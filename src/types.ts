export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type LogMode = "metadata" | "full";

export interface Limits {
  readLines: number;
  readBytes: number;
  searchResults: number;
  commandOutputBytes: number;
  commandTimeoutMs: number;
}

export interface FroeConfig {
  provider: "openai";
  /** Optional OpenAI-compatible API endpoint. */
  baseURL?: string;
  model: string;
  reasoning: ReasoningEffort;
  maxTurns: number;
  logging: LogMode;
  limits: Limits;
  commandEnv: string[];
}

export interface RunOptions {
  workspace: string;
  task?: string;
  images: PromptImage[];
  config: FroeConfig;
  yes: boolean;
  verbose: boolean;
  noLog: boolean;
}

export type ImageMediaType = "image/gif" | "image/jpeg" | "image/png" | "image/webp";

export interface PromptImage {
  data: Uint8Array;
  mediaType: ImageMediaType;
}

export interface ToolDefinition {
  name: ActionName;
  description: string;
  parameters: { [key: string]: JsonValue };
}

export type ActionName =
  | "list_files"
  | "read_file"
  | "search"
  | "apply_patch"
  | "run_command"
  | "finish";

export interface ActionRequest {
  callId: string;
  name: string;
  arguments: unknown;
}

export interface ActionResult {
  callId: string;
  name: string;
  ok: boolean;
  output: JsonValue;
}

export type ModelEvent =
  | { type: "text"; text: string }
  | { type: "action"; action: ActionRequest }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "completed" };

export interface ModelTurn {
  system: string;
  user?: string;
  images?: PromptImage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}

export interface ModelProvider {
  readonly name: string;
  recordActionResults(results: ActionResult[]): void;
  turn(input: ModelTurn): AsyncIterable<ModelEvent>;
}

export type RunStatus = "completed" | "blocked" | "cancelled";

export interface Verification {
  description: string;
  result: "passed" | "not_run" | "failed";
}

export interface RunOutcome {
  status: RunStatus;
  summary: string;
  verification: Verification[];
  turns: number;
}

export type RunEvent =
  | { type: "run_started"; workspace: string; model: string }
  | { type: "model_text"; text: string }
  | { type: "action_requested"; action: ActionRequest }
  | { type: "action_result"; result: ActionResult }
  | { type: "approval_requested"; action: ActionRequest; reason: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "run_finished"; outcome: RunOutcome };

export type EventSink = (event: RunEvent) => void | Promise<void>;

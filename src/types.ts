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

export interface McpStdioServerConfig {
  command: string;
  args: string[];
}

export interface McpRemoteServerConfig {
  url: string;
}

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export interface FroeConfig {
  provider: "openai";
  /** Optional OpenAI-compatible API endpoint. */
  baseURL?: string;
  autoUpdate: boolean;
  model: string;
  reasoning: ReasoningEffort;
  compactThresholdTokens: number | null;
  maxTurns: number;
  logging: LogMode;
  limits: Limits;
  commandEnv: string[];
  /** Standing instructions appended to every run's system prompt. User configuration only. */
  extraInstructions: string[];
  mcpServers: Record<string, McpServerConfig>;
}

export interface RunOptions {
  workspace: string;
  additionalDirectories: string[];
  task?: string;
  imagePaths: string[];
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
  name: string;
  description: string;
  parameters: { [key: string]: JsonValue };
}

export type ActionName =
  | "list_files"
  | "read_file"
  | "search"
  | "web_search"
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

export type ApprovalScope = "policy" | "sandbox_exception";

export type ApprovalDecision = "deny" | "approve_once" | "approve_for_run";

export interface ApprovalRequest {
  id: string;
  action: ActionRequest;
  reason: string;
  destructive: boolean;
  scope: ApprovalScope;
}

export type ModelEvent =
  | { type: "text"; text: string }
  | { type: "action"; action: ActionRequest }
  | { type: "context_compacted"; previousItems: number; retainedItems: number; thresholdTokens: number | null }
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
  resetContinuation?(): void;
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
  | {
    type: "approval_requested";
    approvalId: string;
    action: ActionRequest;
    reason: string;
    destructive: boolean;
    scope: ApprovalScope;
    choices: ApprovalDecision[];
  }
  | { type: "context_compacted"; previousItems: number; retainedItems: number; thresholdTokens: number | null }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "run_finished"; outcome: RunOutcome };

export type EventSink = (event: RunEvent) => void | Promise<void>;

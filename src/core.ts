import { addMcpServer, loadConfig, type ConfigOverrides } from "./config.js";
import {
  DEFAULT_OPENAI_BASE_URL,
  FileCredentialStore,
  saveTavilyApiKey,
  type StoredCredentials,
} from "./credentials.js";
import {
  openFroeSessionWithConfig,
  type FroeConnectionPrompts,
} from "./session-composition.js";
import type { ApprovalMode, FroeSession, FroeSessionAdapter } from "./session.js";
import type { McpServerConfig } from "./types.js";

export {
  FROE_CORE_INTERFACE_VERSION,
  FroeSessionError,
} from "./session.js";
export type {
  ApprovalMode,
  FroeApprovalPrompt,
  FroeRunRequest,
  FroeSession,
  FroeSessionAdapter,
  FroeSessionErrorCode,
  FroeSessionEvent,
  FroeSessionStatus,
} from "./session.js";
export type { ConfigOverrides } from "./config.js";
export type { FroeConnectionPrompts } from "./session-composition.js";
export type { McpServerFailure, McpServerStatus } from "./mcp.js";
export type {
  ActionName,
  ActionRequest,
  ActionResult,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalScope,
  FroeConfig,
  JsonPrimitive,
  JsonValue,
  Limits,
  LogMode,
  McpRemoteServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
  ReasoningEffort,
  RunEvent,
  RunOutcome,
  RunStatus,
  Verification,
} from "./types.js";

export interface OpenFroeSessionOptions {
  workspace: string;
  additionalDirectories?: readonly string[];
  configPath?: string;
  overrides?: ConfigOverrides;
  noLog?: boolean;
  approvalMode?: ApprovalMode;
  connectionPrompts?: FroeConnectionPrompts;
  adapter?: FroeSessionAdapter;
}

export type FroeSetupErrorCode =
  | "invalid_configuration"
  | "credentials_required"
  | "invalid_workspace"
  | "session_start_failed";

export class FroeSetupError extends Error {
  readonly code: FroeSetupErrorCode;

  constructor(code: FroeSetupErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FroeSetupError";
    this.code = code;
  }
}

export type FroeConfigurationCommand =
  | { type: "inspect_connection" }
  | { type: "save_openai_connection"; apiKey: string; baseURL?: string }
  | { type: "save_tavily_api_key"; apiKey: string }
  | { type: "add_mcp_server"; name: string; server: McpServerConfig };

export type FroeConfigurationResult =
  | {
    type: "connection";
    openAIConfigured: boolean;
    baseURL?: string;
    tavilyConfigured: boolean;
  }
  | { type: "configured"; reopenRequired: boolean };

export async function openFroeSession(options: OpenFroeSessionOptions): Promise<FroeSession> {
  let config;
  try {
    config = await loadConfig({
      workspace: options.workspace,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
    });
  } catch (error) {
    throw setupError("invalid_configuration", "Cannot load Froe configuration.", error);
  }

  try {
    return await openFroeSessionWithConfig({
      workspace: options.workspace,
      ...(options.additionalDirectories === undefined ? {} : { additionalDirectories: options.additionalDirectories }),
      config,
      ...(options.noLog === undefined ? {} : { noLog: options.noLog }),
      ...(options.approvalMode === undefined ? {} : { approvalMode: options.approvalMode }),
      ...(options.connectionPrompts === undefined ? {} : { connectionPrompts: options.connectionPrompts }),
      ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
    });
  } catch (error) {
    const message = errorMessage(error);
    if (message.startsWith("No OpenAI API key is available")) {
      throw setupError("credentials_required", message, error);
    }
    if (/Workspace is not a directory|ENOENT|ENOTDIR/.test(message)) {
      throw setupError("invalid_workspace", `Cannot open Froe workspace: ${message}`, error);
    }
    throw setupError("session_start_failed", `Cannot start Froe session: ${message}`, error);
  }
}

export async function configureFroe(command: FroeConfigurationCommand): Promise<FroeConfigurationResult> {
  const store = new FileCredentialStore();
  if (command.type === "inspect_connection") {
    const stored = await store.load();
    const environmentApiKey = normalized(process.env.OPENAI_API_KEY);
    const environmentTavilyKey = normalized(process.env.TAVILY_API_KEY);
    const configuredBaseURL = normalized(process.env.OPENAI_BASE_URL) ?? stored?.baseURL;
    const openAIConfigured = environmentApiKey !== undefined || stored?.apiKey !== undefined;
    return {
      type: "connection",
      openAIConfigured,
      ...(openAIConfigured ? { baseURL: configuredBaseURL ?? DEFAULT_OPENAI_BASE_URL } : {}),
      tavilyConfigured: environmentTavilyKey !== undefined || stored?.tavilyApiKey !== undefined,
    };
  }
  if (command.type === "save_tavily_api_key") {
    await saveTavilyApiKey(command.apiKey, store);
    return { type: "configured", reopenRequired: true };
  }
  if (command.type === "add_mcp_server") {
    await addMcpServer(command.name, command.server);
    return { type: "configured", reopenRequired: true };
  }

  const stored = await store.load();
  const next: StoredCredentials = {
    ...stored,
    apiKey: command.apiKey,
    baseURL: command.baseURL ?? stored?.baseURL ?? DEFAULT_OPENAI_BASE_URL,
  };
  await store.save(next);
  return { type: "configured", reopenRequired: true };
}

function setupError(code: FroeSetupErrorCode, message: string, cause: unknown): FroeSetupError {
  return new FroeSetupError(code, message, { cause });
}

function normalized(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

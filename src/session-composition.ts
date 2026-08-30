import { ActionRuntime } from "./action-runtime.js";
import { createCommandSandbox } from "./command-sandbox.js";
import { FileCredentialStore, resolveOpenAICredentials, resolveTavilyApiKey } from "./credentials.js";
import { discoverProjectInstructions } from "./instructions.js";
import { McpManager } from "./mcp.js";
import { OpenAIProvider } from "./openai-provider.js";
import { RunRecorder } from "./recorder.js";
import {
  createFroeSession,
  SessionApprovalGate,
  type ApprovalMode,
  type FroeSession,
  type FroeSessionAdapter,
} from "./session.js";
import { TavilyWebSearch } from "./tavily-web-search.js";
import type { FroeConfig } from "./types.js";

export interface FroeConnectionPrompts {
  promptApiKey(): Promise<string>;
  promptBaseURL(defaultValue: string): Promise<string>;
  onSaved?(): void;
}

export interface OpenFroeSessionWithConfigOptions {
  workspace: string;
  additionalDirectories?: readonly string[];
  config: FroeConfig;
  noLog?: boolean;
  approvalMode?: ApprovalMode;
  connectionPrompts?: FroeConnectionPrompts;
  adapter?: FroeSessionAdapter;
}

export async function openFroeSessionWithConfig(options: OpenFroeSessionWithConfigOptions): Promise<FroeSession> {
  const credentialStore = new FileCredentialStore();
  const prompts = options.connectionPrompts;
  const credentials = await resolveOpenAICredentials({
    ...(process.env.OPENAI_API_KEY === undefined ? {} : { environmentApiKey: process.env.OPENAI_API_KEY }),
    ...(options.config.baseURL !== undefined
      ? { configuredBaseURL: options.config.baseURL }
      : process.env.OPENAI_BASE_URL === undefined
        ? {}
        : { configuredBaseURL: process.env.OPENAI_BASE_URL }),
    interactive: prompts !== undefined,
    promptApiKey: prompts?.promptApiKey ?? missingPrompt,
    promptBaseURL: prompts?.promptBaseURL ?? missingBaseURLPrompt,
    store: credentialStore,
    ...(prompts?.onSaved === undefined ? {} : { onSaved: prompts.onSaved }),
  });
  const tavilyApiKey = await resolveTavilyApiKey({
    ...(process.env.TAVILY_API_KEY === undefined ? {} : { environmentApiKey: process.env.TAVILY_API_KEY }),
    store: credentialStore,
  });
  const recorder = await RunRecorder.create(options.config.logging, options.noLog ?? false);
  const approval = new SessionApprovalGate(options.approvalMode ?? "prompt", options.adapter);
  const additionalDirectories = [...(options.additionalDirectories ?? [])];
  const commandSandbox = await createCommandSandbox(options.workspace, additionalDirectories);
  const runtime = await ActionRuntime.create(
    options.workspace,
    options.config,
    approval,
    commandSandbox,
    {},
    additionalDirectories,
    new TavilyWebSearch(tavilyApiKey === undefined ? {} : { apiKey: tavilyApiKey }),
  );
  const instructions = await discoverProjectInstructions(runtime.workspace);
  const provider = new OpenAIProvider(options.config, credentials);
  const mcp = await McpManager.connect(options.config.mcpServers);
  return createFroeSession({
    config: options.config,
    model: provider,
    selectModel: (model) => provider.selectModel(model),
    runtime,
    mcp,
    instructions,
    recorder,
    approval,
    ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
  });
}

async function missingPrompt(): Promise<string> {
  throw new Error("No OpenAI API key prompt is available.");
}

async function missingBaseURLPrompt(_defaultValue: string): Promise<string> {
  throw new Error("No OpenAI Base URL prompt is available.");
}

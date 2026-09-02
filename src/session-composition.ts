import type { ResponseInputItem } from "openai/resources/responses/responses";
import { ActionRuntime } from "./action-runtime.js";
import { createCommandSandbox } from "./command-sandbox.js";
import { FileCredentialStore, resolveOpenAICredentials, resolveTavilyApiKey } from "./credentials.js";
import { ConversationHistoryStore } from "./conversation-history.js";
import { discoverProjectInstructions } from "./instructions.js";
import { discoverSkills } from "./skills.js";
import { McpManager } from "./mcp.js";
import { OpenAIProvider } from "./openai-provider.js";
import { RunRecorder } from "./recorder.js";
import {
  createFroeSession,
  SessionApprovalGate,
  type ApprovalMode,
  type FroeSession,
  type FroeSessionAdapter,
  type FroeSessionEvent,
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
  resumeHistory?: boolean;
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
  const historyStore = options.resumeHistory === true ? ConversationHistoryStore.forWorkspace(options.workspace) : undefined;
  const restoredHistory = (await historyStore?.load() ?? []) as unknown as ResponseInputItem[];
  const instructions = await discoverProjectInstructions(options.workspace);
  const skills = await discoverSkills({
    workspace: options.workspace,
    ...(options.additionalDirectories === undefined ? {} : { additionalDirectories: options.additionalDirectories }),
  });
  const userSkillDirectories = skills
    .filter((skill) => skill.scope === "user")
    .map((skill) => skill.directory);
  const additionalDirectories = [
    ...new Set([...(options.additionalDirectories ?? []), ...userSkillDirectories]),
  ];
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
  const provider = new OpenAIProvider(options.config, {
    apiKey: credentials.apiKey,
    baseURL: credentials.baseURL,
    ...(restoredHistory.length === 0 ? {} : { history: restoredHistory }),
  });
  const mcp = await McpManager.connect(options.config.mcpServers);
  const historyAdapter = withConversationHistoryPersistence(options.adapter, historyStore, provider);
  return createFroeSession({
    config: options.config,
    model: provider,
    selectModel: (model) => provider.selectModel(model),
    runtime,
    mcp,
    instructions,
    skills,
    recorder,
    approval,
    ...(historyAdapter === undefined ? {} : { adapter: historyAdapter }),
    ...(historyStore === undefined
      ? {}
      : {
        onConversationReset: async (): Promise<void> => {
          await historyStore.clear();
        },
      }),
  });
}

function withConversationHistoryPersistence(
  adapter: FroeSessionAdapter | undefined,
  store: ConversationHistoryStore | undefined,
  provider: OpenAIProvider,
): FroeSessionAdapter | undefined {
  if (store === undefined) return adapter;
  const onEvent = async (envelope: FroeSessionEvent): Promise<void> => {
    try {
      if (envelope.event.type === "run_finished") await store.save(provider.exportHistory());
    } catch {
      // Persistence is best-effort: a failed history write must not turn a
      // completed run into a reported failure or lose its already-recorded
      // events. The in-memory conversation still continues normally.
    }
    await adapter?.onEvent?.(envelope);
  };
  return { ...adapter, onEvent };
}

async function missingPrompt(): Promise<string> {
  throw new Error("No OpenAI API key prompt is available.");
}

async function missingBaseURLPrompt(_defaultValue: string): Promise<string> {
  throw new Error("No OpenAI Base URL prompt is available.");
}

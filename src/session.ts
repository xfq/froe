import { randomUUID } from "node:crypto";
import type { ActionRuntime, ApprovalGate } from "./action-runtime.js";
import type { ProjectInstruction } from "./instructions.js";
import type { AgentSkill } from "./skills.js";
import type { McpManager, McpServerFailure, McpServerStatus } from "./mcp.js";
import { loadPromptImages } from "./prompt-images.js";
import type { RunRecorder } from "./recorder.js";
import { runTask } from "./run.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  FroeConfig,
  ModelProvider,
  RunEvent,
  RunOutcome,
} from "./types.js";

export const FROE_CORE_INTERFACE_VERSION = 1 as const;

export type ApprovalMode = "prompt" | "auto_non_destructive";

export interface FroeApprovalPrompt extends ApprovalRequest {
  choices: ApprovalDecision[];
}

export interface FroeSessionAdapter {
  onEvent?(event: FroeSessionEvent): void | Promise<void>;
  requestApproval?(prompt: FroeApprovalPrompt, signal?: AbortSignal): Promise<ApprovalDecision>;
}

export interface FroeSessionEvent {
  interfaceVersion: typeof FROE_CORE_INTERFACE_VERSION;
  sessionId: string;
  runId: string;
  sequence: number;
  event: RunEvent;
}

export interface FroeSessionStatus {
  interfaceVersion: typeof FROE_CORE_INTERFACE_VERSION;
  sessionId: string;
  workspace: string;
  additionalDirectories: string[];
  config: FroeConfig;
  recordPath?: string;
  activeMcpServers: McpServerStatus[];
  mcpFailures: McpServerFailure[];
  activeRunId?: string;
}

export interface FroeRunRequest {
  task: string;
  imagePaths?: readonly string[];
  model?: string;
  signal?: AbortSignal;
}

export interface FroeSession {
  status(): FroeSessionStatus;
  run(request: FroeRunRequest): Promise<RunOutcome>;
  resetConversation?(): Promise<void>;
  close(): Promise<void>;
}

export type FroeSessionErrorCode = "empty_task" | "session_busy" | "session_closed";

export class FroeSessionError extends Error {
  readonly code: FroeSessionErrorCode;

  constructor(code: FroeSessionErrorCode, message: string) {
    super(message);
    this.name = "FroeSessionError";
    this.code = code;
  }
}

export interface FroeSessionDependencies {
  config: FroeConfig;
  model: ModelProvider;
  selectModel(model: string): void | Promise<void>;
  runtime: ActionRuntime;
  mcp: McpManager;
  instructions: ProjectInstruction[];
  skills?: AgentSkill[];
  recorder: RunRecorder;
  approval: SessionApprovalGate;
  adapter?: FroeSessionAdapter;
  onConversationReset?: () => void | Promise<void>;
}

interface ActiveRun {
  id: string;
  controller: AbortController;
  result: Promise<RunOutcome>;
}

export class SessionApprovalGate implements ApprovalGate {
  readonly #mode: ApprovalMode;
  readonly #adapter: FroeSessionAdapter;
  readonly #approvedCategories = new Set<string>();
  #emit: ((event: RunEvent) => void | Promise<void>) | undefined;

  constructor(mode: ApprovalMode, adapter: FroeSessionAdapter = {}) {
    this.#mode = mode;
    this.#adapter = adapter;
  }

  setEventSink(emit: ((event: RunEvent) => void | Promise<void>) | undefined): void {
    this.#emit = emit;
  }

  beginRun(): void {
    this.#approvedCategories.clear();
  }

  async request(request: ApprovalRequest, signal?: AbortSignal): Promise<boolean> {
    const choices = approvalChoices(request);
    await this.#emit?.({
      type: "approval_requested",
      approvalId: request.id,
      action: request.action,
      reason: request.reason,
      destructive: request.destructive,
      scope: request.scope,
      choices,
    });
    if (signal?.aborted) return false;
    if (request.scope === "policy" && this.#approvedCategories.has(request.action.name)) return true;
    if (request.scope === "policy" && this.#mode === "auto_non_destructive" && !request.destructive) return true;

    const decision = await this.#adapter.requestApproval?.({ ...request, choices }, signal) ?? "deny";
    if (signal?.aborted || !choices.includes(decision)) return false;
    if (decision === "approve_for_run") this.#approvedCategories.add(request.action.name);
    return decision !== "deny";
  }
}

export function createFroeSession(dependencies: FroeSessionDependencies): FroeSession {
  return new DefaultFroeSession(dependencies);
}

class DefaultFroeSession implements FroeSession {
  readonly #sessionId = randomUUID();
  readonly #config: FroeConfig;
  readonly #model: ModelProvider;
  readonly #selectModel: (model: string) => void | Promise<void>;
  readonly #runtime: ActionRuntime;
  readonly #mcp: McpManager;
  readonly #instructions: ProjectInstruction[];
  readonly #skills: AgentSkill[];
  readonly #recorder: RunRecorder;
  readonly #approval: SessionApprovalGate;
  readonly #adapter: FroeSessionAdapter;
  readonly #onConversationReset: (() => void | Promise<void>) | undefined;
  #modelName: string;
  #sequence = 0;
  #active: ActiveRun | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(dependencies: FroeSessionDependencies) {
    this.#config = dependencies.config;
    this.#model = dependencies.model;
    this.#selectModel = dependencies.selectModel;
    this.#runtime = dependencies.runtime;
    this.#mcp = dependencies.mcp;
    this.#instructions = dependencies.instructions;
    this.#skills = dependencies.skills ?? [];
    this.#recorder = dependencies.recorder;
    this.#approval = dependencies.approval;
    this.#adapter = dependencies.adapter ?? {};
    this.#onConversationReset = dependencies.onConversationReset;
    this.#modelName = dependencies.config.model;
  }

  status(): FroeSessionStatus {
    const recordPath = this.#recorder.path;
    return {
      interfaceVersion: FROE_CORE_INTERFACE_VERSION,
      sessionId: this.#sessionId,
      workspace: this.#runtime.workspace,
      additionalDirectories: [...this.#runtime.additionalDirectories],
      config: { ...structuredClone(this.#config), model: this.#modelName },
      ...(recordPath === undefined ? {} : { recordPath }),
      activeMcpServers: this.#mcp.activeServers.map((server) => ({ ...server })),
      mcpFailures: this.#mcp.failures.map((failure) => ({ ...failure })),
      ...(this.#active === undefined ? {} : { activeRunId: this.#active.id }),
    };
  }

  run(request: FroeRunRequest): Promise<RunOutcome> {
    if (this.#closed) throw new FroeSessionError("session_closed", "This Froe session is closed.");
    if (this.#active !== undefined) throw new FroeSessionError("session_busy", "This Froe session already has an active run.");
    if (!request.task.trim()) throw new FroeSessionError("empty_task", "A run task must not be empty.");

    const id = randomUUID();
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) controller.abort();
    const result = this.#executeRun(id, request, controller, onAbort);
    this.#active = { id, controller, result };
    return result;
  }

  async resetConversation(): Promise<void> {
    if (this.#closed) throw new FroeSessionError("session_closed", "This Froe session is closed.");
    if (this.#active !== undefined) throw new FroeSessionError("session_busy", "This Froe session already has an active run.");
    this.#model.resetContinuation?.();
    await this.#onConversationReset?.();
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #executeRun(
    runId: string,
    request: FroeRunRequest,
    controller: AbortController,
    onAbort: () => void,
  ): Promise<RunOutcome> {
    const emit = (event: RunEvent): Promise<void> => this.#publish(runId, event);
    this.#approval.beginRun();
    this.#approval.setEventSink(emit);
    try {
      const images = await loadPromptImages([...(request.imagePaths ?? [])]);
      if (!controller.signal.aborted && request.model !== undefined && request.model !== this.#modelName) {
        await this.#selectModel(request.model);
        this.#modelName = request.model;
      }
      return await runTask({
        task: request.task,
        ...(images.length === 0 ? {} : { images }),
        model: this.#model,
        runtime: this.#runtime,
        mcp: this.#mcp,
        instructions: this.#instructions,
        skills: this.#skills,
        modelName: this.#modelName,
        maxTurns: this.#config.maxTurns,
        signal: controller.signal,
        emit,
      });
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
      this.#approval.setEventSink(undefined);
      if (this.#active?.id === runId) this.#active = undefined;
    }
  }

  async #publish(runId: string, event: RunEvent): Promise<void> {
    await this.#recorder.record(event);
    this.#sequence += 1;
    await this.#adapter.onEvent?.({
      interfaceVersion: FROE_CORE_INTERFACE_VERSION,
      sessionId: this.#sessionId,
      runId,
      sequence: this.#sequence,
      event,
    });
  }

  async #performClose(): Promise<void> {
    this.#closed = true;
    const active = this.#active;
    active?.controller.abort();
    if (active !== undefined) await active.result.catch(() => undefined);
    await this.#mcp.close();
  }
}

function approvalChoices(request: ApprovalRequest): ApprovalDecision[] {
  return request.scope === "policy" && !request.destructive
    ? ["approve_once", "deny", "approve_for_run"]
    : ["approve_once", "deny"];
}

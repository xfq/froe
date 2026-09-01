import OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type { ResponseInputItem, ResponseInputMessageContentList, ResponseOutputItem } from "openai/resources/responses/responses";
import type { ActionRequest, ActionResult, FroeConfig, JsonValue, ModelEvent, ModelProvider, ModelTurn, PromptImage } from "./types.js";

export class OpenAIProvider implements ModelProvider {
  readonly name = "openai";
  readonly #client: OpenAI;
  readonly #config: FroeConfig;
  #model: string;
  #history: ResponseInputItem[] = [];

  constructor(config: FroeConfig, options: OpenAIProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for the openai provider");
    this.#config = config;
    this.#model = config.model;
    this.#history = options.history === undefined ? [] : [...options.history];
    const baseURL = options.baseURL ?? config.baseURL ?? process.env.OPENAI_BASE_URL;
    this.#client = new OpenAI({ apiKey, maxRetries: 2, ...(baseURL === undefined ? {} : { baseURL }) });
  }

  selectModel(model: string): void {
    const normalized = model.trim();
    if (!normalized) throw new Error("model cannot be empty");
    this.#model = normalized;
  }

  recordActionResults(results: ActionResult[]): void {
    for (const result of results) {
      this.#history.push({
        type: "function_call_output",
        call_id: result.callId,
        output: JSON.stringify({ ok: result.ok, output: result.output }),
      });
    }
  }

  /**
   * Returns the current continuation items as JSON for persistence. Attached
   * image bytes are stripped because they belong only to the invocation that
   * supplied them and would bloat the stored history with stale base64 data.
   */
  exportHistory(): JsonValue[] {
    return persistableHistory(this.#history);
  }

  resetContinuation(): void {
    this.#history = [];
  }

  async *turn(input: ModelTurn): AsyncIterable<ModelEvent> {
    if (input.user !== undefined) this.#history.push(userMessage(input.user, input.images ?? []));

    const response = await this.#client.responses.create({
      model: this.#model,
      instructions: input.system,
      input: this.#history,
      tools: input.tools.map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
      })),
      reasoning: { effort: this.#config.reasoning },
      include: ["reasoning.encrypted_content"],
      store: false,
      ...(this.#config.compactThresholdTokens === null
        ? {}
        : { context_management: [{ type: "compaction", compact_threshold: this.#config.compactThresholdTokens }] }),
      parallel_tool_calls: false,
    }, input.signal === undefined ? undefined : { signal: input.signal });

    const previousItems = this.#history.length;
    const latestCompaction = response.output.findLastIndex((item) => item.type === "compaction");
    const continuation = toResponseInputItems(latestCompaction === -1
      ? response.output
      : response.output.slice(latestCompaction));
    if (latestCompaction === -1) this.#history.push(...continuation);
    else {
      this.#history = continuation;
      yield {
        type: "context_compacted",
        previousItems,
        retainedItems: continuation.length,
        thresholdTokens: this.#config.compactThresholdTokens,
      };
    }

    for (const item of response.output) {
      yield* modelEventsFor(item);
    }
    if (response.usage !== undefined) {
      yield {
        type: "usage",
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    }
    yield { type: "completed" };
  }
}

function userMessage(text: string, images: PromptImage[]): ResponseInputItem {
  if (images.length === 0) return { role: "user", content: text };
  const content: ResponseInputMessageContentList = [
    { type: "input_text", text },
    ...images.map((image) => ({
      type: "input_image" as const,
      detail: "auto" as const,
      image_url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`,
    })),
  ];
  return { role: "user", content };
}

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseURL?: string;
  history?: readonly ResponseInputItem[];
}

function* modelEventsFor(item: ResponseOutputItem): Generator<ModelEvent> {
  if (item.type === "function_call") {
    yield {
      type: "action",
      action: {
        callId: item.call_id,
        name: item.name,
        arguments: parseArguments(item.arguments),
      },
    };
    return;
  }
  if (item.type === "message") {
    for (const content of item.content) {
      if (content.type === "output_text" && content.text) yield { type: "text", text: content.text };
      if (content.type === "refusal") yield { type: "text", text: `Model refusal: ${content.refusal}` };
    }
  }
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { __froe_invalid_json: raw };
  }
}

function persistableHistory(history: readonly ResponseInputItem[]): JsonValue[] {
  const result: JsonValue[] = [];
  for (const item of history) {
    const content = messageContent(item);
    if (content === undefined) {
      result.push(item as unknown as JsonValue);
      continue;
    }
    const stripped = content.filter((part) => part.type !== "input_image");
    if (stripped.length === 0) continue;
    result.push((stripped.length === content.length ? item : { ...item, content: stripped }) as unknown as JsonValue);
  }
  return result;
}

function messageContent(item: ResponseInputItem): ResponseInputMessageContentList | undefined {
  if (item === null || typeof item !== "object" || !("role" in item) || !("content" in item)) return undefined;
  const content = item.content;
  if (typeof content === "string" || !Array.isArray(content)) return undefined;
  return content as unknown as ResponseInputMessageContentList;
}

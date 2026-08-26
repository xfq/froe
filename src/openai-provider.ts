import OpenAI from "openai";
import type { ResponseInputItem, ResponseInputMessageContentList, ResponseOutputItem } from "openai/resources/responses/responses";
import type { ActionRequest, ActionResult, FroeConfig, ModelEvent, ModelProvider, ModelTurn, PromptImage } from "./types.js";

export class OpenAIProvider implements ModelProvider {
  readonly name = "openai";
  readonly #client: OpenAI;
  readonly #config: FroeConfig;
  #history: ResponseInputItem[] = [];

  constructor(config: FroeConfig, options: OpenAIProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for the openai provider");
    this.#config = config;
    const baseURL = options.baseURL ?? config.baseURL ?? process.env.OPENAI_BASE_URL;
    this.#client = new OpenAI({ apiKey, maxRetries: 2, ...(baseURL === undefined ? {} : { baseURL }) });
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

  async *turn(input: ModelTurn): AsyncIterable<ModelEvent> {
    if (input.user !== undefined) this.#history.push(userMessage(input.user, input.images ?? []));

    const response = await this.#client.responses.create({
      model: this.#config.model,
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
      parallel_tool_calls: false,
    }, input.signal === undefined ? undefined : { signal: input.signal });

    for (const item of response.output) {
      const replayable = replayableItem(item);
      if (replayable !== undefined) this.#history.push(replayable);
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
}

function replayableItem(item: ResponseOutputItem): ResponseInputItem | undefined {
  if (item.type === "message" || item.type === "function_call" || item.type === "reasoning") return item;
  return undefined;
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

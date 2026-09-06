import OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type {
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
  ResponseInputMessageContentList,
  ResponseOutputItem,
} from "openai/resources/responses/responses";
import type { ActionRequest, ActionResult, FroeConfig, GeneratedImageMediaType, JsonValue, ModelEvent, ModelProvider, ModelTurn, PromptImage } from "./types.js";

export class OpenAIProvider implements ModelProvider {
  readonly name = "openai";
  readonly #client: OpenAI;
  readonly #config: FroeConfig;
  readonly #modelsWithoutImageGeneration = new Set<string>();
  #model: string;
  #history: ResponseInputItem[] = [];

  constructor(config: FroeConfig, options: OpenAIProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for the openai provider");
    this.#config = config;
    this.#model = config.model;
    // Image-generation call IDs are server-side response items. They cannot be
    // resumed with this provider's `store: false` privacy boundary, including
    // when a history file was written by an earlier Froe version.
    this.#history = options.history === undefined ? [] : withoutImageGenerationCalls(options.history);
    const baseURL = options.baseURL ?? config.baseURL ?? process.env.OPENAI_BASE_URL;
    this.#client = new OpenAI({ apiKey, maxRetries: 2, ...(baseURL === undefined ? {} : { baseURL }) });
  }

  selectModel(model: string): void {
    const normalized = model.trim();
    if (!normalized) throw new Error("model cannot be empty");
    this.#model = normalized;
  }

  imageGenerationAvailable(): boolean {
    return this.#config.imageGeneration.enabled
      && !this.#modelsWithoutImageGeneration.has(modelKey(this.#model));
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
   * image bytes and image-generation calls are omitted: neither can be replayed
   * in a later stateless Responses request.
   */
  exportHistory(): JsonValue[] {
    return persistableHistory(this.#history);
  }

  resetContinuation(): void {
    this.#history = [];
  }

  async *turn(input: ModelTurn): AsyncIterable<ModelEvent> {
    if (input.user !== undefined) this.#history.push(userMessage(input.user, input.images ?? []));

    const { response, imageGenerationEnabled } = await this.#responseForTurn(input);

    const previousItems = this.#history.length;
    const latestCompaction = response.output.findLastIndex((item) => item.type === "compaction");
    const continuation = continuationItems(latestCompaction === -1
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
      yield* modelEventsFor(item, imageGenerationEnabled ? this.#config.imageGeneration.outputFormat : undefined);
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

  async #responseForTurn(input: ModelTurn): Promise<{
    response: OpenAIResponse;
    imageGenerationEnabled: boolean;
  }> {
    const imageGenerationEnabled = this.imageGenerationAvailable();
    try {
      return {
        response: await this.#createResponse(input, imageGenerationEnabled),
        imageGenerationEnabled,
      };
    } catch (error) {
      if (!imageGenerationEnabled || !isUnsupportedImageGenerationTool(error)) throw error;
      this.#modelsWithoutImageGeneration.add(modelKey(this.#model));
      return {
        response: await this.#createResponse(input, false, true),
        imageGenerationEnabled: false,
      };
    }
  }

  async #createResponse(
    input: ModelTurn,
    imageGenerationEnabled: boolean,
    explainImageGenerationUnavailable = false,
  ): Promise<OpenAIResponse> {
    const request: ResponseCreateParamsNonStreaming = {
      model: this.#model,
      instructions: explainImageGenerationUnavailable
        ? `${input.system}\n\nImage generation is unavailable with the current model. Do not claim that you created or edited an image.`
        : input.system,
      input: this.#history,
      tools: [
        ...input.tools.map((tool) => ({
          type: "function" as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: false,
        })),
        ...(imageGenerationEnabled ? [{
          type: "image_generation" as const,
          model: this.#config.imageGeneration.model,
          size: this.#config.imageGeneration.size,
          quality: this.#config.imageGeneration.quality,
          background: this.#config.imageGeneration.background,
          output_format: this.#config.imageGeneration.outputFormat,
        }] : []),
      ],
      reasoning: { effort: this.#config.reasoning },
      include: ["reasoning.encrypted_content"],
      store: false,
      ...(this.#config.compactThresholdTokens === null
        ? {}
        : { context_management: [{ type: "compaction", compact_threshold: this.#config.compactThresholdTokens }] }),
      parallel_tool_calls: false,
    };
    return await this.#client.responses.create(request, input.signal === undefined ? undefined : { signal: input.signal });
  }
}

function modelKey(model: string): string {
  return model.trim().toLowerCase();
}

function continuationItems(items: Iterable<ResponseOutputItem>): ResponseInputItem[] {
  return withoutImageGenerationCalls(toResponseInputItems(items));
}

function withoutImageGenerationCalls(items: readonly ResponseInputItem[]): ResponseInputItem[] {
  return items.filter((item) => !isImageGenerationCall(item));
}

function isUnsupportedImageGenerationTool(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const apiError = error as Error & {
    status?: unknown;
    code?: unknown;
    param?: unknown;
    type?: unknown;
  };
  if (typeof apiError.status !== "number" || apiError.status < 400 || apiError.status >= 500) return false;
  const detail = [apiError.message, apiError.code, apiError.param, apiError.type]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /image[_ -]?generation/i.test(detail)
    && /(?:\btool\b|\btools\b)/i.test(detail)
    && /\b(?:unsupported|not supported|unavailable|not available|does not support|unknown|invalid)\b/i.test(detail);
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

function* modelEventsFor(
  item: ResponseOutputItem,
  outputFormat: FroeConfig["imageGeneration"]["outputFormat"] | undefined,
): Generator<ModelEvent> {
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
    return;
  }
  if (item.type === "image_generation_call" && item.result !== null && outputFormat !== undefined) {
    yield {
      type: "image_generated",
      image: {
        data: decodeGeneratedImage(item.result),
        mediaType: generatedImageMediaType(outputFormat),
      },
    };
  }
}

function decodeGeneratedImage(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("OpenAI returned an invalid base64 image result");
  }
  const data = Buffer.from(value, "base64");
  if (data.length === 0) throw new Error("OpenAI returned an empty image result");
  return new Uint8Array(data);
}

function generatedImageMediaType(outputFormat: FroeConfig["imageGeneration"]["outputFormat"]): GeneratedImageMediaType {
  if (outputFormat === "jpeg") return "image/jpeg";
  if (outputFormat === "webp") return "image/webp";
  return "image/png";
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
    if (isImageGenerationCall(item)) {
      continue;
    }
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

function isImageGenerationCall(item: ResponseInputItem): item is Extract<ResponseInputItem, { type: "image_generation_call" }> {
  return item !== null && typeof item === "object" && "type" in item && item.type === "image_generation_call";
}

function messageContent(item: ResponseInputItem): ResponseInputMessageContentList | undefined {
  if (item === null || typeof item !== "object" || !("role" in item) || !("content" in item)) return undefined;
  const content = item.content;
  if (typeof content === "string" || !Array.isArray(content)) return undefined;
  return content as unknown as ResponseInputMessageContentList;
}

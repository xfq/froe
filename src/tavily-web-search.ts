import type { JsonValue } from "./types.js";

const tavilySearchURL = "https://api.tavily.com/search";

export interface WebSearchRequest {
  query: string;
  maxResults: number;
  searchDepth: "basic" | "advanced";
  signal?: AbortSignal;
}

export interface WebSearch {
  readonly isConfigured: boolean;
  search(request: WebSearchRequest): Promise<JsonValue>;
}

export interface TavilyWebSearchOptions {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

export class TavilyWebSearchError extends Error {
  constructor(readonly code: "web_search_unavailable" | "web_search_failed", message: string) {
    super(message);
  }
}

export class TavilyWebSearch implements WebSearch {
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: TavilyWebSearchOptions = {}) {
    this.#apiKey = normalizedKey(options.apiKey ?? process.env.TAVILY_API_KEY);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  get isConfigured(): boolean {
    return this.#apiKey !== undefined;
  }

  async search(request: WebSearchRequest): Promise<JsonValue> {
    if (this.#apiKey === undefined) {
      throw new TavilyWebSearchError("web_search_unavailable", "TAVILY_API_KEY is required to use web_search.");
    }

    let response: Response;
    try {
      response = await this.#fetch(tavilySearchURL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: request.query,
          max_results: request.maxResults,
          search_depth: request.searchDepth,
          include_answer: false,
          include_raw_content: false,
          include_images: false,
          include_favicon: false,
        }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch {
      throw new TavilyWebSearchError("web_search_failed", "Tavily could not be reached.");
    }

    if (!response.ok) {
      throw new TavilyWebSearchError("web_search_failed", responseErrorMessage(response.status));
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TavilyWebSearchError("web_search_failed", "Tavily returned an invalid JSON response.");
    }
    return normalizeResponse(payload, request);
  }
}

function normalizedKey(value: string | undefined): string | undefined {
  const key = value?.trim();
  return key ? key : undefined;
}

function responseErrorMessage(status: number): string {
  if (status === 401) return "Tavily rejected TAVILY_API_KEY.";
  if (status === 429) return "Tavily rate limited web search.";
  return `Tavily rejected web search with HTTP ${status}.`;
}

function normalizeResponse(payload: unknown, request: WebSearchRequest): JsonValue {
  const body = record(payload);
  if (body === undefined || !Array.isArray(body.results)) {
    throw new TavilyWebSearchError("web_search_failed", "Tavily returned an unexpected response.");
  }
  const results = body.results
    .slice(0, request.maxResults)
    .map(normalizeResult)
    .filter((result): result is JsonValue => result !== undefined);
  const response: { query: string; results: JsonValue[]; responseTime?: JsonValue } = {
    query: request.query,
    results,
  };
  if (typeof body.response_time === "number" || typeof body.response_time === "string") {
    response.responseTime = body.response_time;
  }
  return response;
}

function normalizeResult(value: unknown): JsonValue | undefined {
  const result = record(value);
  if (result === undefined || typeof result.url !== "string" || typeof result.title !== "string" || typeof result.content !== "string") {
    return undefined;
  }
  const normalized: { title: string; url: string; content: string; score?: number } = {
    title: result.title,
    url: result.url,
    content: result.content.slice(0, 4_000),
  };
  if (typeof result.score === "number") normalized.score = result.score;
  return normalized;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

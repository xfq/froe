import assert from "node:assert/strict";
import test from "node:test";
import { TavilyWebSearch, TavilyWebSearchError } from "../src/tavily-web-search.js";

test("Tavily search sends a bounded request and returns normalized sources", async () => {
  let receivedURL: string | undefined;
  let receivedInit: RequestInit | undefined;
  const search = new TavilyWebSearch({
    apiKey: "tvly-test-key",
    fetch: async (url, init) => {
      receivedURL = String(url);
      receivedInit = init;
      return new Response(JSON.stringify({
        response_time: "0.42",
        results: [
          { title: "Tavily", url: "https://tavily.com", content: "Search result", score: 0.99 },
          { title: "Malformed", content: "Ignored because it has no URL" },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const result = await search.search({ query: "Tavily API", maxResults: 5, searchDepth: "advanced" });

  assert.equal(receivedURL, "https://api.tavily.com/search");
  assert.ok(receivedInit);
  assert.equal(receivedInit.method, "POST");
  assert.equal(new Headers(receivedInit.headers).get("Authorization"), "Bearer tvly-test-key");
  assert.deepEqual(JSON.parse(String(receivedInit.body)), {
    query: "Tavily API",
    max_results: 5,
    search_depth: "advanced",
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    include_favicon: false,
  });
  assert.deepEqual(result, {
    query: "Tavily API",
    responseTime: "0.42",
    results: [{ title: "Tavily", url: "https://tavily.com", content: "Search result", score: 0.99 }],
  });
});

test("Tavily search reports missing keys and HTTP failures without response bodies", async () => {
  const unavailable = new TavilyWebSearch({ apiKey: " " });
  await assert.rejects(
    () => unavailable.search({ query: "ignored", maxResults: 5, searchDepth: "basic" }),
    (error: unknown) => error instanceof TavilyWebSearchError
      && error.code === "web_search_unavailable"
      && error.message === "TAVILY_API_KEY is required to use web_search.",
  );

  const rejected = new TavilyWebSearch({
    apiKey: "tvly-test-key",
    fetch: async () => new Response("a server response that must not be exposed", { status: 429 }),
  });
  await assert.rejects(
    () => rejected.search({ query: "ignored", maxResults: 5, searchDepth: "basic" }),
    (error: unknown) => error instanceof TavilyWebSearchError
      && error.code === "web_search_failed"
      && error.message === "Tavily rate limited web search.",
  );
});

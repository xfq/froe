import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { once } from "node:events";
import { OpenAIProvider } from "../src/openai-provider.js";
import { defaultConfig } from "../src/config.js";
import type { ModelEvent, ModelTurn } from "../src/types.js";

test("the OpenAI adapter sends stateless function-call turns to a local server", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    const secondTurn = requests.length === 2;
    const payload = secondTurn
      ? responseWithMessage("done")
      : responseWithFunctionCall("finish", "call_finish", JSON.stringify({
        outcome: "blocked",
        summary: "No changes needed.",
        verification: [{ description: "Inspected the workspace", result: "passed" }],
      }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP server address");
    const provider = new OpenAIProvider(defaultConfig, { apiKey: "test-key", baseURL: `http://127.0.0.1:${address.port}/v1` });
    const tools = [{ name: "finish" as const, description: "Finish", parameters: { type: "object" } }];

    const first = await collect(provider.turn({ system: "test system", user: "inspect", tools }));
    assert.deepEqual(first[0], {
      type: "action",
      action: {
        callId: "call_finish",
        name: "finish",
        arguments: {
          outcome: "blocked",
          summary: "No changes needed.",
          verification: [{ description: "Inspected the workspace", result: "passed" }],
        },
      },
    });

    provider.recordActionResults([{ callId: "call_finish", name: "finish", ok: true, output: { outcome: "blocked" } }]);
    const second = await collect(provider.turn({
      system: "test system",
      user: "Please check one more thing",
      tools,
    }));
    assert.deepEqual(second[0], { type: "text", text: "done" });
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.store, false);
    assert.equal(requests[0]?.parallel_tool_calls, false);
    const history = requests[1]?.input;
    assert.equal(Array.isArray(history), true);
    const items = history as unknown[];
    assert.deepEqual(items[0], { role: "user", content: "inspect" });
    assert.equal((items[1] as Record<string, unknown>).type, "function_call");
    assert.equal((items[1] as Record<string, unknown>).call_id, "call_finish");
    assert.equal((items[2] as Record<string, unknown>).type, "function_call_output");
    assert.equal((items[2] as Record<string, unknown>).call_id, "call_finish");
    assert.equal((items[2] as Record<string, unknown>).output, JSON.stringify({ ok: true, output: { outcome: "blocked" } }));
    assert.deepEqual(items[3], { role: "user", content: "Please check one more thing" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("the OpenAI adapter reads OPENAI_BASE_URL", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/v1/responses");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responseWithMessage("done")));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const previous = process.env.OPENAI_BASE_URL;
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP server address");
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    const provider = new OpenAIProvider(defaultConfig, { apiKey: "test-key" });
    const events = await collect(provider.turn({ system: "test system", user: "inspect", tools: [] }));
    assert.deepEqual(events[0], { type: "text", text: "done" });
  } finally {
    if (previous === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previous;
    server.close();
    await once(server, "close");
  }
});

test("the OpenAI adapter sends each attached image as input_image content", async () => {
  let received: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responseWithMessage("done")));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP server address");
    const provider = new OpenAIProvider(defaultConfig, { apiKey: "test-key", baseURL: `http://127.0.0.1:${address.port}/v1` });

    await collect(provider.turn({
      system: "test system",
      user: "Inspect these screenshots",
      images: [
        { data: Uint8Array.of(1, 2, 3), mediaType: "image/png" },
        { data: Uint8Array.of(4, 5, 6), mediaType: "image/jpeg" },
      ],
      tools: [],
    }));

    const input = received?.input;
    assert.equal(Array.isArray(input), true);
    assert.deepEqual((input as Array<Record<string, unknown>>)[0], {
      role: "user",
      content: [
        { type: "input_text", text: "Inspect these screenshots" },
        { type: "input_image", detail: "auto", image_url: "data:image/png;base64,AQID" },
        { type: "input_image", detail: "auto", image_url: "data:image/jpeg;base64,BAUG" },
      ],
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const collected: ModelEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function responseWithFunctionCall(name: string, callId: string, arguments_: string): object {
  return {
    id: "resp_1",
    object: "response",
    created_at: 0,
    status: "completed",
    output: [{ type: "function_call", id: "fc_1", call_id: callId, name, arguments: arguments_, status: "completed" }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  };
}

function responseWithMessage(text: string): object {
  return {
    id: "resp_2",
    object: "response",
    created_at: 0,
    status: "completed",
    output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  };
}

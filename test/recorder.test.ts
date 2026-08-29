import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunRecorder } from "../src/recorder.js";

test("metadata run records retain context compaction counts", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "froe-recorder-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateRoot;
  try {
    const recorder = await RunRecorder.create("metadata", false);
    await recorder.record({
      type: "context_compacted",
      previousItems: 120,
      retainedItems: 3,
      thresholdTokens: 200_000,
    });
    assert.notEqual(recorder.path, undefined);
    const record = JSON.parse(await readFile(recorder.path as string, "utf8")) as Record<string, unknown>;

    assert.deepEqual(record.event, {
      type: "context_compacted",
      previousItems: 120,
      retainedItems: 3,
      thresholdTokens: 200_000,
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});

test("metadata run records omit Tavily queries and source excerpts", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "froe-recorder-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateRoot;
  try {
    const recorder = await RunRecorder.create("metadata", false);
    await recorder.record({
      type: "action_requested",
      action: { callId: "search", name: "web_search", arguments: { query: "private search query" } },
    });
    await recorder.record({
      type: "action_result",
      result: {
        callId: "search",
        name: "web_search",
        ok: true,
        output: {
          query: "private search query",
          results: [{ title: "Private source", url: "https://example.test", content: "private source excerpt" }],
        },
      },
    });

    const contents = await readFile(recorder.path as string, "utf8");
    assert.doesNotMatch(contents, /private search query|Private source|private source excerpt/);
    const records = contents.trim().split("\n").map((line) => JSON.parse(line) as { event: unknown });
    assert.deepEqual(records.map((record) => record.event), [
      { type: "action_requested", callId: "search", name: "web_search", summary: [] },
      { type: "action_result", callId: "search", name: "web_search", ok: true, result: { sourceCount: 1 } },
    ]);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});

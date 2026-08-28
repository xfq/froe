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

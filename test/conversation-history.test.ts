import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ConversationHistoryStore } from "../src/conversation-history.js";

const items = [
  { role: "user", content: "Earlier task" },
  { type: "function_call_output", call_id: "earlier", output: "{}" },
  { type: "compaction", id: "cmp_1", encrypted_content: "opaque-state" },
];

test("conversation history round-trips through an owner-only state file", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "froe-history-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateRoot;
  try {
    const store = ConversationHistoryStore.forWorkspace("/work/project");
    await store.save(items);

    assert.deepEqual(await store.load(), items);
    const metadata = await stat(store.path);
    if (process.platform !== "win32") assert.equal(metadata.mode & 0o077, 0);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});

test("conversation history is isolated per workspace", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "froe-history-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateRoot;
  try {
    const first = ConversationHistoryStore.forWorkspace("/work/project");
    const second = ConversationHistoryStore.forWorkspace("/work/other");
    await first.save(items);

    assert.deepEqual(await second.load(), []);
    assert.notEqual(first.path, second.path);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});

test("missing, corrupt, or foreign conversation history starts fresh", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "froe-history-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateRoot;
  try {
    const store = ConversationHistoryStore.forWorkspace("/work/project");
    assert.deepEqual(await store.load(), []);

    await mkdir(dirname(store.path), { recursive: true });
    await writeFile(store.path, "not json\n", "utf8");
    assert.deepEqual(await store.load(), []);

    await writeFile(store.path, JSON.stringify({ version: 2, workspace: "/work/project", items }), "utf8");
    assert.deepEqual(await store.load(), []);

    await writeFile(store.path, JSON.stringify({ version: 1, workspace: "/work/other", items }), "utf8");
    assert.deepEqual(await store.load(), []);

    await writeFile(store.path, JSON.stringify({ version: 1, workspace: "/work/project", items: [{ nope: true }, ...items] }), "utf8");
    assert.deepEqual(await store.load(), items);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});

test("clearing removes the persisted conversation history", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "froe-history-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateRoot;
  try {
    const store = ConversationHistoryStore.forWorkspace("/work/project");
    await store.save(items);
    await store.clear();

    assert.deepEqual(await store.load(), []);
    await store.clear();
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});

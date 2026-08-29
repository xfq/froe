import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_OPENAI_BASE_URL,
  FileCredentialStore,
  resolveOpenAICredentials,
  resolveTavilyApiKey,
  saveTavilyApiKey,
  type CredentialStore,
  type StoredCredentials,
} from "../src/credentials.js";

class MemoryCredentialStore implements CredentialStore {
  value: StoredCredentials | undefined;
  loads = 0;
  saves = 0;

  constructor(value?: StoredCredentials) {
    this.value = value;
  }

  async load(): Promise<StoredCredentials | undefined> {
    this.loads += 1;
    return this.value;
  }

  async save(credentials: StoredCredentials): Promise<void> {
    this.saves += 1;
    this.value = credentials;
  }
}

test("an environment connection bypasses stored credentials", async () => {
  const store = new MemoryCredentialStore({ apiKey: "stored-key", baseURL: "https://stored.example/v1" });
  const credentials = await resolveOpenAICredentials({
    environmentApiKey: " environment-key ",
    configuredBaseURL: "https://configured.example/v1",
    interactive: true,
    promptApiKey: async () => "unused-key",
    promptBaseURL: async () => "https://unused.example/v1",
    store,
  });

  assert.deepEqual(credentials, {
    apiKey: "environment-key",
    baseURL: "https://configured.example/v1",
  });
  assert.equal(store.loads, 0);
  assert.equal(store.saves, 0);
});

test("a saved connection is reused without prompting", async () => {
  const store = new MemoryCredentialStore({ apiKey: "stored-key", baseURL: "https://saved.example/v1" });
  const credentials = await resolveOpenAICredentials({
    interactive: true,
    promptApiKey: async () => { throw new Error("API key prompt should not be called"); },
    promptBaseURL: async () => { throw new Error("Base URL prompt should not be called"); },
    store,
  });

  assert.deepEqual(credentials, { apiKey: "stored-key", baseURL: "https://saved.example/v1" });
  assert.equal(store.loads, 1);
  assert.equal(store.saves, 0);
});

test("the first interactive run prompts for and saves the complete connection", async () => {
  const store = new MemoryCredentialStore();
  let savedNotification = false;
  const credentials = await resolveOpenAICredentials({
    interactive: true,
    promptApiKey: async () => " prompted-key ",
    promptBaseURL: async (defaultValue) => {
      assert.equal(defaultValue, DEFAULT_OPENAI_BASE_URL);
      return " https://provider.example/v1 ";
    },
    store,
    onSaved: () => {
      savedNotification = true;
    },
  });

  assert.deepEqual(credentials, { apiKey: "prompted-key", baseURL: "https://provider.example/v1" });
  assert.deepEqual(store.value, credentials);
  assert.equal(store.saves, 1);
  assert.equal(savedNotification, true);
});

test("saving a Tavily key preserves the OpenAI connection", async () => {
  const store = new MemoryCredentialStore({ apiKey: "openai-key", baseURL: "https://api.example/v1" });

  await saveTavilyApiKey(" tavily-key ", store);

  assert.deepEqual(store.value, {
    apiKey: "openai-key",
    baseURL: "https://api.example/v1",
    tavilyApiKey: "tavily-key",
  });
  assert.equal(await resolveTavilyApiKey({ store }), "tavily-key");
});

test("saving an OpenAI connection preserves the Tavily key", async () => {
  const store = new MemoryCredentialStore({ tavilyApiKey: "tavily-key" });

  await resolveOpenAICredentials({
    interactive: true,
    promptApiKey: async () => "openai-key",
    promptBaseURL: async () => "https://api.example/v1",
    store,
  });

  assert.deepEqual(store.value, {
    apiKey: "openai-key",
    baseURL: "https://api.example/v1",
    tavilyApiKey: "tavily-key",
  });
});

test("a Tavily environment key overrides the saved key", async () => {
  const store = new MemoryCredentialStore({ tavilyApiKey: "saved-key" });

  assert.equal(await resolveTavilyApiKey({ environmentApiKey: " environment-key ", store }), "environment-key");
  assert.equal(store.loads, 0);
});

test("an empty first-run Base URL selects the OpenAI default", async () => {
  const credentials = await resolveOpenAICredentials({
    interactive: true,
    promptApiKey: async () => "prompted-key",
    promptBaseURL: async () => "",
    store: new MemoryCredentialStore(),
  });

  assert.equal(credentials.baseURL, DEFAULT_OPENAI_BASE_URL);
});

test("the first-run Base URL must be an absolute HTTP(S) URL", async () => {
  const store = new MemoryCredentialStore();
  await assert.rejects(
    resolveOpenAICredentials({
      interactive: true,
      promptApiKey: async () => "prompted-key",
      promptBaseURL: async () => "provider.example/v1",
      store,
    }),
    /absolute HTTP\(S\) URL/,
  );
  assert.equal(store.saves, 0);
});

test("an explicitly configured Base URL is saved without prompting for it", async () => {
  const store = new MemoryCredentialStore();
  const credentials = await resolveOpenAICredentials({
    configuredBaseURL: "https://configured.example/v1",
    interactive: true,
    promptApiKey: async () => "prompted-key",
    promptBaseURL: async () => { throw new Error("Base URL prompt should not be called"); },
    store,
  });

  assert.deepEqual(credentials, { apiKey: "prompted-key", baseURL: "https://configured.example/v1" });
  assert.deepEqual(store.value, credentials);
});

test("a saved API key from the previous format prompts once for its Base URL", async () => {
  const store = new MemoryCredentialStore({ apiKey: "stored-key" });
  const credentials = await resolveOpenAICredentials({
    interactive: true,
    promptApiKey: async () => { throw new Error("API key prompt should not be called"); },
    promptBaseURL: async () => "https://migrated.example/v1",
    store,
  });

  assert.deepEqual(credentials, { apiKey: "stored-key", baseURL: "https://migrated.example/v1" });
  assert.deepEqual(store.value, credentials);
  assert.equal(store.saves, 1);
});

test("a non-interactive run requires an environment or saved API key", async () => {
  await assert.rejects(
    resolveOpenAICredentials({
      interactive: false,
      promptApiKey: async () => "unused",
      promptBaseURL: async () => "unused",
      store: new MemoryCredentialStore(),
    }),
    /Run froe once in an interactive terminal.*OPENAI_API_KEY/,
  );
});

test("file credentials are private and can be loaded again", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-credentials-"));
  const path = join(root, "nested", "credentials.json");
  const store = new FileCredentialStore(path);

  await saveTavilyApiKey("tavily-key", store);
  assert.deepEqual(await store.load(), { tavilyApiKey: "tavily-key" });

  await store.save({ apiKey: "saved-key", baseURL: "https://saved.example/v1", tavilyApiKey: "tavily-key" });

  assert.deepEqual(await store.load(), { apiKey: "saved-key", baseURL: "https://saved.example/v1", tavilyApiKey: "tavily-key" });
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
});

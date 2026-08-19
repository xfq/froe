import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CredentialStore {
  load(): Promise<StoredCredentials | undefined>;
  save(credentials: OpenAICredentials): Promise<void>;
}

export interface StoredCredentials {
  apiKey?: string;
  baseURL?: string;
}

export interface OpenAICredentials {
  apiKey: string;
  baseURL: string;
}

export interface ResolveCredentialsOptions {
  environmentApiKey?: string;
  configuredBaseURL?: string;
  interactive: boolean;
  promptApiKey: () => Promise<string>;
  promptBaseURL: (defaultValue: string) => Promise<string>;
  store: CredentialStore;
  onSaved?: () => void;
}

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export async function resolveOpenAICredentials(options: ResolveCredentialsOptions): Promise<OpenAICredentials> {
  const environmentApiKey = normalizedKey(options.environmentApiKey);
  if (environmentApiKey !== undefined) {
    return {
      apiKey: environmentApiKey,
      baseURL: normalizedBaseURL(options.configuredBaseURL) ?? DEFAULT_OPENAI_BASE_URL,
    };
  }

  const stored = await options.store.load();
  let apiKey = normalizedKey(stored?.apiKey);
  let baseURL = normalizedBaseURL(options.configuredBaseURL ?? stored?.baseURL);
  let shouldSave = false;

  if (apiKey === undefined && !options.interactive) {
    throw new Error(
      "No OpenAI API key is available. Run froe once in an interactive terminal to sign in, or set OPENAI_API_KEY.",
    );
  }

  if (apiKey === undefined) {
    apiKey = normalizedKey(await options.promptApiKey());
    if (apiKey === undefined) throw new Error("An OpenAI API key is required to continue.");
    shouldSave = true;
  }

  if (baseURL === undefined && shouldSave) {
    baseURL = normalizedBaseURL(await options.promptBaseURL(DEFAULT_OPENAI_BASE_URL), true);
  } else if (baseURL === undefined && stored?.apiKey !== undefined && options.interactive) {
    baseURL = normalizedBaseURL(await options.promptBaseURL(DEFAULT_OPENAI_BASE_URL), true);
    shouldSave = true;
  }
  baseURL ??= DEFAULT_OPENAI_BASE_URL;

  if (shouldSave) {
    await options.store.save({ apiKey, baseURL });
    options.onSaved?.();
  }
  return { apiKey, baseURL };
}

export class FileCredentialStore implements CredentialStore {
  readonly path: string;

  constructor(path = defaultCredentialPath()) {
    this.path = path;
  }

  async load(): Promise<StoredCredentials | undefined> {
    let contents: string;
    try {
      const metadata = await stat(this.path);
      if (!metadata.isFile()) throw new Error(`Credential path is not a file: ${this.path}`);
      if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
        throw new Error(`Credential file permissions are too broad: ${this.path} must be readable only by its owner`);
      }
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot parse credentials ${this.path}: ${reason}`);
    }
    if (!isRecord(parsed) || typeof parsed.openaiApiKey !== "string" || normalizedKey(parsed.openaiApiKey) === undefined) {
      throw new Error(`Credentials ${this.path} must contain a non-empty openaiApiKey`);
    }
    if (parsed.openaiBaseURL !== undefined && typeof parsed.openaiBaseURL !== "string") {
      throw new Error(`Credentials ${this.path}.openaiBaseURL must be a string`);
    }
    const baseURL = normalizedBaseURL(parsed.openaiBaseURL as string | undefined);
    return {
      apiKey: parsed.openaiApiKey.trim(),
      ...(baseURL === undefined ? {} : { baseURL }),
    };
  }

  async save(credentials: OpenAICredentials): Promise<void> {
    const apiKey = normalizedKey(credentials.apiKey);
    if (apiKey === undefined) throw new Error("Cannot save an empty OpenAI API key");
    const baseURL = normalizedBaseURL(credentials.baseURL);
    if (baseURL === undefined) throw new Error("Cannot save an empty OpenAI Base URL");
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(
      this.path,
      `${JSON.stringify({ openaiApiKey: apiKey, openaiBaseURL: baseURL }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    if (process.platform !== "win32") await chmod(this.path, 0o600);
  }
}

export function defaultCredentialPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "froe", "credentials.json");
}

function normalizedKey(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizedBaseURL(value: string | undefined, useDefaultForEmpty = false): string | undefined {
  const normalized = value?.trim() || (useDefaultForEmpty ? DEFAULT_OPENAI_BASE_URL : undefined);
  if (normalized === undefined) return undefined;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw new Error("OpenAI Base URL must be an absolute HTTP(S) URL");
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { FroeConfig, JsonValue, Limits, LogMode, McpRemoteServerConfig, McpServerConfig, McpStdioServerConfig, ReasoningEffort } from "./types.js";

const reasoningValues = new Set<ReasoningEffort>(["none", "low", "medium", "high", "xhigh", "max"]);
const logValues = new Set<LogMode>(["metadata", "full"]);

export const defaultConfig: FroeConfig = {
  provider: "openai",
  autoUpdate: true,
  model: "gpt-5.6-terra",
  reasoning: "medium",
  compactThresholdTokens: 200_000,
  maxTurns: 40,
  logging: "metadata",
  limits: {
    readLines: 400,
    readBytes: 128 * 1024,
    searchResults: 200,
    commandOutputBytes: 128 * 1024,
    commandTimeoutMs: 120_000,
  },
  commandEnv: [],
  mcpServers: {},
};

type ConfigLayer = Partial<Omit<FroeConfig, "limits" | "mcpServers">> & {
  $schema?: string;
  limits?: Partial<Limits>;
  mcpServers?: Record<string, McpServerConfig>;
};

export interface ConfigOverrides {
  baseURL?: string;
  autoUpdate?: boolean;
  model?: string;
  reasoning?: ReasoningEffort;
  maxTurns?: number;
  logging?: LogMode;
}

export interface LoadConfigOptions {
  workspace: string;
  configPath?: string;
  overrides?: ConfigOverrides;
}

export async function loadConfig(options: LoadConfigOptions): Promise<FroeConfig> {
  const userPath = userConfigPath();
  const workspacePath = join(options.workspace, ".froe", "config.json");
  const userLayer = await readConfigIfPresent(userPath, "user");
  const workspaceLayer = await readConfigIfPresent(workspacePath, "workspace");
  const explicitLayer = options.configPath === undefined
    ? undefined
    : await readConfig(resolve(options.configPath), "user");

  return mergeConfig(defaultConfig, userLayer, workspaceLayer, explicitLayer, options.overrides);
}

export async function addMcpServer(name: string, server: McpServerConfig): Promise<void> {
  const path = userConfigPath();
  const parsed = parseMcpServers({ [name]: server }, path);
  const userLayer = await readConfigIfPresent(path, "user");
  if (userLayer?.mcpServers?.[name] !== undefined) {
    throw new Error(`MCP server ${name} is already configured.`);
  }
  const next: ConfigLayer = {
    ...userLayer,
    mcpServers: { ...userLayer?.mcpServers, ...parsed },
  };
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.config.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await removeTemporaryConfig(temporaryPath);
    throw error;
  }
}

export function mergeConfig(
  base: FroeConfig,
  ...layers: Array<ConfigLayer | ConfigOverrides | undefined>
): FroeConfig {
  const merged: FroeConfig = {
    ...base,
    limits: { ...base.limits },
    commandEnv: [...base.commandEnv],
    mcpServers: { ...base.mcpServers },
  };

  for (const layer of layers) {
    if (layer === undefined) {
      continue;
    }
    if (layer.model !== undefined) merged.model = layer.model;
    if ("baseURL" in layer && layer.baseURL !== undefined) merged.baseURL = layer.baseURL;
    if ("autoUpdate" in layer && layer.autoUpdate !== undefined) merged.autoUpdate = layer.autoUpdate;
    if (layer.reasoning !== undefined) merged.reasoning = layer.reasoning;
    if ("compactThresholdTokens" in layer && layer.compactThresholdTokens !== undefined) {
      merged.compactThresholdTokens = layer.compactThresholdTokens;
    }
    if (layer.maxTurns !== undefined) merged.maxTurns = layer.maxTurns;
    if ("logging" in layer && layer.logging !== undefined) merged.logging = layer.logging;
    if ("provider" in layer && layer.provider !== undefined) merged.provider = layer.provider;
    if ("commandEnv" in layer && layer.commandEnv !== undefined) merged.commandEnv = [...layer.commandEnv];
    if ("mcpServers" in layer && layer.mcpServers !== undefined) merged.mcpServers = { ...merged.mcpServers, ...layer.mcpServers };
    if ("limits" in layer && layer.limits !== undefined) Object.assign(merged.limits, layer.limits);
  }

  validateResolvedConfig(merged);
  return merged;
}

async function readConfigIfPresent(path: string, scope: "user" | "workspace"): Promise<ConfigLayer | undefined> {
  try {
    await access(path);
  } catch {
    return undefined;
  }
  return readConfig(path, scope);
}

async function readConfig(path: string, scope: "user" | "workspace"): Promise<ConfigLayer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot parse configuration ${path}: ${reason}`);
  }
  return parseLayer(parsed, path, scope);
}

function parseLayer(value: unknown, path: string, scope: "user" | "workspace"): ConfigLayer {
  const object = objectValue(value, path);
  assertOnlyKeys(object, ["$schema", "provider", "baseURL", "autoUpdate", "model", "reasoning", "compactThresholdTokens", "maxTurns", "logging", "limits", "commandEnv", "mcpServers"], path);
  if (scope === "workspace") {
    const restricted = ["provider", "baseURL", "autoUpdate", "reasoning", "compactThresholdTokens", "maxTurns", "logging", "commandEnv", "mcpServers"].find((key) => object[key] !== undefined);
    if (restricted !== undefined) throw new Error(`${path}.${restricted} is allowed only in user configuration`);
  }
  const layer: ConfigLayer = {};

  if (object.$schema !== undefined) layer.$schema = stringValue(object.$schema, `${path}.$schema`);
  if (object.provider !== undefined) {
    if (object.provider !== "openai") throw new Error(`${path}.provider must be "openai" in this release`);
    layer.provider = "openai";
  }
  if (object.baseURL !== undefined) layer.baseURL = urlValue(object.baseURL, `${path}.baseURL`);
  if (object.autoUpdate !== undefined) layer.autoUpdate = booleanValue(object.autoUpdate, `${path}.autoUpdate`);
  if (object.model !== undefined) layer.model = stringValue(object.model, `${path}.model`);
  if (object.reasoning !== undefined) {
    const reasoning = stringValue(object.reasoning, `${path}.reasoning`);
    if (!reasoningValues.has(reasoning as ReasoningEffort)) throw new Error(`${path}.reasoning is not supported`);
    layer.reasoning = reasoning as ReasoningEffort;
  }
  if (object.compactThresholdTokens !== undefined) {
    layer.compactThresholdTokens = object.compactThresholdTokens === null
      ? null
      : positiveInteger(object.compactThresholdTokens, `${path}.compactThresholdTokens`);
  }
  if (object.maxTurns !== undefined) layer.maxTurns = positiveInteger(object.maxTurns, `${path}.maxTurns`);
  if (object.logging !== undefined) {
    const logging = stringValue(object.logging, `${path}.logging`);
    if (!logValues.has(logging as LogMode)) throw new Error(`${path}.logging must be metadata or full`);
    layer.logging = logging as LogMode;
  }
  if (object.commandEnv !== undefined) {
    if (scope === "workspace") throw new Error(`${path}.commandEnv is allowed only in user configuration`);
    layer.commandEnv = stringArray(object.commandEnv, `${path}.commandEnv`);
  }
  if (object.mcpServers !== undefined) {
    if (scope === "workspace") throw new Error(`${path}.mcpServers is allowed only in user configuration`);
    layer.mcpServers = parseMcpServers(object.mcpServers, `${path}.mcpServers`);
  }
  if (object.limits !== undefined) {
    const limits = objectValue(object.limits, `${path}.limits`);
    assertOnlyKeys(limits, ["readLines", "readBytes", "searchResults", "commandOutputBytes", "commandTimeoutMs"], `${path}.limits`);
    layer.limits = {};
    for (const [key, raw] of Object.entries(limits)) {
      layer.limits[key as keyof Limits] = positiveInteger(raw, `${path}.limits.${key}`);
    }
  }
  return layer;
}

function validateResolvedConfig(config: FroeConfig): void {
  if (config.provider !== "openai") throw new Error("Only the openai provider is implemented in this release");
  if (config.baseURL !== undefined) urlValue(config.baseURL, "baseURL");
  booleanValue(config.autoUpdate, "autoUpdate");
  if (!config.model.trim()) throw new Error("model cannot be empty");
  if (!reasoningValues.has(config.reasoning)) throw new Error("reasoning is not supported");
  if (config.compactThresholdTokens !== null) {
    positiveInteger(config.compactThresholdTokens, "compactThresholdTokens");
  }
  if (!logValues.has(config.logging)) throw new Error("logging is not supported");
  for (const [key, value] of Object.entries(config.limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`limits.${key} must be a positive integer`);
  }
  if (!Number.isSafeInteger(config.maxTurns) || config.maxTurns < 1) throw new Error("maxTurns must be a positive integer");
  parseMcpServers(config.mcpServers, "mcpServers");
}

function userConfigPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "froe", "config.json");
}

function parseMcpServers(value: unknown, path: string): Record<string, McpServerConfig> {
  const servers = objectValue(value, path);
  const parsed: Record<string, McpServerConfig> = {};
  for (const [name, rawServer] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(name)) {
      throw new Error(`${path}.${name} must use 1-32 letters, numbers, underscores, or hyphens`);
    }
    const server = objectValue(rawServer, `${path}.${name}`);
    if (server.url !== undefined) {
      assertOnlyKeys(server, ["url"], `${path}.${name}`);
      parsed[name] = { url: urlValue(server.url, `${path}.${name}.url`) } satisfies McpRemoteServerConfig;
    } else {
      assertOnlyKeys(server, ["command", "args"], `${path}.${name}`);
      parsed[name] = {
        command: stringValue(server.command, `${path}.${name}.command`),
        args: server.args === undefined ? [] : stringArray(server.args, `${path}.${name}.args`),
      } satisfies McpStdioServerConfig;
    }
  }
  return parsed;
}

async function removeTemporaryConfig(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // The temporary file was not created or was already moved into place.
  }
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function assertOnlyKeys(object: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key} is not a supported setting`);
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function urlValue(value: unknown, path: string): string {
  const url = stringValue(value, path);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw new Error(`${path} must be an absolute HTTP(S) URL`);
  }
  return url;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${path} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${path} must be a positive integer`);
  }
  return value;
}

export function stringifyJson(value: JsonValue): string {
  return JSON.stringify(value);
}

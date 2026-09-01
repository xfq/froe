import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionRequest, ActionResult, JsonValue, McpServerConfig, ToolDefinition } from "./types.js";

const protocolVersion = "2025-06-18";
const requestTimeoutMs = 30_000;
const maximumMessageBytes = 1_024 * 1_024;

export interface McpServerStatus {
  name: string;
  toolCount: number;
}

export interface McpServerFailure {
  name: string;
  message: string;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema: { [key: string]: JsonValue };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
  removeAbortListener?: () => void;
}

interface McpConnection {
  readonly active: boolean;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, arguments_: { [key: string]: JsonValue }, signal?: AbortSignal): Promise<JsonValue>;
  close(): Promise<void>;
}

export class McpManager {
  readonly #clients = new Map<string, McpConnection>();
  readonly #tools: ToolDefinition[] = [];
  readonly #toolTargets = new Map<string, { client: McpConnection; toolName: string }>();
  readonly #activeServers: McpServerStatus[] = [];
  readonly #failures: McpServerFailure[] = [];

  private constructor() {}

  static async connect(servers: Record<string, McpServerConfig>): Promise<McpManager> {
    const manager = new McpManager();
    for (const [name, config] of Object.entries(servers)) {
      let client: McpConnection | undefined;
      try {
        client = await connectMcpServer(name, config);
        const tools = await client.listTools();
        let toolCount = 0;
        for (const tool of tools) {
          const exposedName = toolName(name, tool.name);
          if (exposedName === undefined) continue;
          const definition: ToolDefinition = {
            name: exposedName,
            description: tool.description?.trim() || `${name} MCP tool ${tool.name}.`,
            parameters: tool.inputSchema,
          };
          manager.#tools.push(definition);
          manager.#toolTargets.set(exposedName, { client, toolName: tool.name });
          toolCount += 1;
        }
        manager.#clients.set(name, client);
        manager.#activeServers.push({ name, toolCount });
      } catch (error) {
        await client?.close();
        manager.#failures.push({ name, message: errorMessage(error) });
      }
    }
    return manager;
  }

  get tools(): readonly ToolDefinition[] {
    return this.#tools.filter((tool) => this.#toolTargets.get(tool.name)?.client.active);
  }

  get activeServers(): readonly McpServerStatus[] {
    return this.#activeServers.filter((server) => this.#clients.get(server.name)?.active);
  }

  get failures(): readonly McpServerFailure[] {
    return this.#failures;
  }

  hasTool(name: string): boolean {
    return this.#toolTargets.get(name)?.client.active === true;
  }

  async execute(request: ActionRequest, signal?: AbortSignal): Promise<ActionResult> {
    const target = this.#toolTargets.get(request.name);
    if (target === undefined || !target.client.active) return failure(request, "unknown_mcp_tool", `Unknown MCP tool: ${request.name}`);
    if (signal?.aborted) throw new Error("Run cancelled");
    if (!record(request.arguments)) {
      return failure(request, "invalid_mcp_arguments", `${request.name} requires an object of arguments.`);
    }
    try {
      const output = await target.client.callTool(target.toolName, request.arguments as { [key: string]: JsonValue }, signal);
      return { callId: request.callId, name: request.name, ok: true, output };
    } catch (error) {
      return failure(request, "mcp_tool_failed", errorMessage(error));
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.#clients.values()].map((client) => client.close()));
  }
}

async function connectMcpServer(name: string, config: McpServerConfig): Promise<McpConnection> {
  return "url" in config ? RemoteMcpClient.connect(name, config.url) : StdioMcpClient.connect(name, config);
}

class StdioMcpClient implements McpConnection {
  readonly #name: string;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #home: string;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 0;
  #stdout = "";
  #stderr = "";
  #closed = false;

  private constructor(name: string, child: ChildProcessWithoutNullStreams, home: string) {
    this.#name = name;
    this.#child = child;
    this.#home = home;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#readStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-4_000);
    });
    child.on("error", (error) => this.#closeWithError(new Error(`MCP server ${name} could not start: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (!this.#closed) {
        const detail = this.#stderr.trim();
        this.#closeWithError(new Error(`MCP server ${name} closed (${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}`));
      }
    });
  }

  static async connect(name: string, config: Extract<McpServerConfig, { command: string }>): Promise<StdioMcpClient> {
    const home = await mkdtemp(join(tmpdir(), "froe-mcp-"));
    const child = spawn(config.command, config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: mcpEnvironment(home),
    });
    const client = new StdioMcpClient(name, child, home);
    try {
      await client.request("initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "froe", version: "0.3.0" },
      });
      client.notify("notifications/initialized");
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  get active(): boolean {
    return !this.#closed;
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const response = record(await this.request("tools/list", cursor === undefined ? {} : { cursor }));
      if (response === undefined || !Array.isArray(response.tools)) {
        throw new Error(`MCP server ${this.#name} returned an invalid tools/list response.`);
      }
      for (const candidate of response.tools) {
        const tool = parseTool(candidate);
        if (tool !== undefined) tools.push(tool);
      }
      cursor = typeof response.nextCursor === "string" && response.nextCursor ? response.nextCursor : undefined;
    } while (cursor !== undefined);
    return tools;
  }

  async callTool(name: string, arguments_: { [key: string]: JsonValue }, signal?: AbortSignal): Promise<JsonValue> {
    const response = await this.request("tools/call", { name, arguments: arguments_ }, signal);
    const result = jsonValue(response);
    if (result === undefined) throw new Error(`MCP server ${this.#name} returned a non-JSON tool result.`);
    if (record(result)?.isError === true) {
      throw new Error(`MCP tool ${name} failed: ${mcpErrorMessage(result)}`);
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new Error(`MCP server ${this.#name} was closed.`));
    this.#child.stdin.end();
    this.#child.kill();
    await rm(this.#home, { recursive: true, force: true });
  }

  notify(method: string): void {
    this.#write({ jsonrpc: "2.0", method });
  }

  async request(method: string, params: { [key: string]: JsonValue }, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) throw new Error(`MCP server ${this.#name} is not running.`);
    const id = ++this.#nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#takePending(id)?.reject(new Error(`MCP server ${this.#name} did not answer ${method} within ${requestTimeoutMs / 1_000} seconds.`));
      }, requestTimeoutMs);
      const onAbort = (): void => {
        this.#takePending(id)?.reject(new Error("Run cancelled"));
      };
      this.#pending.set(id, {
        resolve,
        reject,
        timeout,
        ...(signal === undefined ? {} : { removeAbortListener: () => signal.removeEventListener("abort", onAbort) }),
      });
      if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.#takePending(id)?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #write(message: object): void {
    if (this.#closed || !this.#child.stdin.writable) throw new Error(`MCP server ${this.#name} is not running.`);
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #readStdout(chunk: string): void {
    this.#stdout += chunk;
    if (Buffer.byteLength(this.#stdout) > maximumMessageBytes) {
      this.#closeWithError(new Error(`MCP server ${this.#name} sent a message larger than ${maximumMessageBytes} bytes.`));
      return;
    }
    let newline: number;
    while ((newline = this.#stdout.indexOf("\n")) !== -1) {
      const line = this.#stdout.slice(0, newline);
      this.#stdout = this.#stdout.slice(newline + 1);
      if (line.trim()) this.#readMessage(line);
    }
  }

  #readMessage(line: string): void {
    let message: { id?: unknown; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
    } catch {
      this.#closeWithError(new Error(`MCP server ${this.#name} wrote invalid JSON to stdout.`));
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#takePending(message.id);
    if (pending === undefined) return;
    if (message.error !== undefined) {
      pending.reject(new Error(`MCP server ${this.#name} rejected the request: ${jsonErrorMessage(message.error)}`));
      return;
    }
    pending.resolve(message.result);
  }

  #closeWithError(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(error);
    this.#child.stdin.end();
    this.#child.kill();
    void rm(this.#home, { recursive: true, force: true });
  }

  #rejectPending(error: Error): void {
    for (const id of [...this.#pending.keys()]) {
      this.#takePending(id)?.reject(error);
    }
  }

  #takePending(id: number): PendingRequest | undefined {
    const pending = this.#pending.get(id);
    if (pending === undefined) return undefined;
    this.#pending.delete(id);
    clearTimeout(pending.timeout);
    pending.removeAbortListener?.();
    return pending;
  }
}

class RemoteMcpClient implements McpConnection {
  readonly #name: string;
  readonly #url: URL;
  readonly #controllers = new Set<AbortController>();
  #nextId = 0;
  #sessionId: string | undefined;
  #initialized = false;
  #closed = false;

  private constructor(name: string, url: string) {
    this.#name = name;
    this.#url = new URL(url);
  }

  static async connect(name: string, url: string): Promise<RemoteMcpClient> {
    const client = new RemoteMcpClient(name, url);
    try {
      await client.request("initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "froe", version: "0.3.0" },
      });
      client.#initialized = true;
      await client.notify("notifications/initialized");
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  get active(): boolean {
    return !this.#closed;
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const response = record(await this.request("tools/list", cursor === undefined ? {} : { cursor }));
      if (response === undefined || !Array.isArray(response.tools)) {
        throw new Error(`MCP server ${this.#name} returned an invalid tools/list response.`);
      }
      for (const candidate of response.tools) {
        const tool = parseTool(candidate);
        if (tool !== undefined) tools.push(tool);
      }
      cursor = typeof response.nextCursor === "string" && response.nextCursor ? response.nextCursor : undefined;
    } while (cursor !== undefined);
    return tools;
  }

  async callTool(name: string, arguments_: { [key: string]: JsonValue }, signal?: AbortSignal): Promise<JsonValue> {
    const response = await this.request("tools/call", { name, arguments: arguments_ }, signal);
    const result = jsonValue(response);
    if (result === undefined) throw new Error(`MCP server ${this.#name} returned a non-JSON tool result.`);
    if (record(result)?.isError === true) {
      throw new Error(`MCP tool ${name} failed: ${mcpErrorMessage(result)}`);
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    if (this.#sessionId === undefined) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      await fetch(this.#url, {
        method: "DELETE",
        headers: this.#headers("application/json"),
        signal: controller.signal,
      });
    } catch {
      // Closing a remote server must not turn cleanup into a run failure.
    } finally {
      clearTimeout(timeout);
    }
  }

  async notify(method: string): Promise<void> {
    await this.#send({ jsonrpc: "2.0", method });
  }

  async request(method: string, params: { [key: string]: JsonValue }, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) throw new Error(`MCP server ${this.#name} is not running.`);
    if (signal?.aborted) throw new Error("Run cancelled");
    const id = ++this.#nextId;
    return this.#send({ jsonrpc: "2.0", id, method, params }, signal, id);
  }

  async #send(message: object, signal?: AbortSignal, expectedId?: number): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    this.#controllers.add(controller);
    try {
      const response = await fetch(this.#url, {
        method: "POST",
        headers: this.#headers("application/json, text/event-stream", "application/json"),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId !== null) this.#sessionId = sessionId;
      if (!response.ok) throw await remoteHttpError(this.#name, response);
      if (expectedId === undefined) {
        await response.body?.cancel();
        return undefined;
      }
      if (response.status === 202) {
        throw new Error(`MCP server ${this.#name} accepted ${messageMethod(message)} without a JSON-RPC response.`);
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType === "application/json") return remoteJsonResponse(this.#name, await readRemoteBody(response, this.#name), expectedId);
      if (contentType === "text/event-stream") return remoteSseResponse(response, this.#name, expectedId);
      throw new Error(`MCP server ${this.#name} returned unsupported content type ${contentType === undefined ? "(none)" : contentType}.`);
    } catch (error) {
      if (signal?.aborted) throw new Error("Run cancelled");
      if (controller.signal.aborted) {
        throw new Error(`MCP server ${this.#name} did not answer within ${requestTimeoutMs / 1_000} seconds.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      this.#controllers.delete(controller);
    }
  }

  #headers(accept: string, contentType?: string): Headers {
    const headers = new Headers({ Accept: accept });
    if (contentType !== undefined) headers.set("Content-Type", contentType);
    if (this.#initialized) headers.set("MCP-Protocol-Version", protocolVersion);
    if (this.#sessionId !== undefined) headers.set("Mcp-Session-Id", this.#sessionId);
    return headers;
  }
}

async function remoteHttpError(name: string, response: Response): Promise<Error> {
  let detail = "";
  try {
    detail = (await readRemoteBody(response, name)).trim();
  } catch {
    // Preserve the HTTP status when an error body is malformed or too large.
  }
  return new Error(`MCP server ${name} rejected the request (${response.status}${response.statusText ? ` ${response.statusText}` : ""})${detail ? `: ${detail.slice(0, 1_000)}` : ""}`);
}

async function readRemoteBody(response: Response, name: string): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumMessageBytes) throw new Error(`MCP server ${name} sent a message larger than ${maximumMessageBytes} bytes.`);
      text += decoder.decode(value, { stream: true });
    }
    return `${text}${decoder.decode()}`;
  } finally {
    reader.releaseLock();
  }
}

async function remoteSseResponse(response: Response, name: string, expectedId: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error(`MCP server ${name} returned an empty SSE response.`);
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffer) > maximumMessageBytes) {
        throw new Error(`MCP server ${name} sent a message larger than ${maximumMessageBytes} bytes.`);
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length === 0) continue;
          const result = remoteJsonResponse(name, data.join("\n"), expectedId, true);
          data = [];
          if (result !== undefined) return result;
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
    throw new Error(`MCP server ${name} closed its SSE response before answering the request.`);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function remoteJsonResponse(name: string, text: string, expectedId: number, allowUnrelated = false): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`MCP server ${name} returned invalid JSON.`);
  }
  const message = record(parsed);
  if (message === undefined) throw new Error(`MCP server ${name} returned an invalid JSON-RPC response.`);
  if (message.id !== expectedId) {
    if (allowUnrelated) return undefined;
    throw new Error(`MCP server ${name} returned a response for an unexpected request.`);
  }
  if (message.error !== undefined) throw new Error(`MCP server ${name} rejected the request: ${jsonErrorMessage(message.error)}`);
  if (!("result" in message)) throw new Error(`MCP server ${name} returned an invalid JSON-RPC response.`);
  return message.result;
}

function messageMethod(message: object): string {
  const value = record(message);
  return typeof value?.method === "string" ? value.method : "the request";
}

function parseTool(value: unknown): McpTool | undefined {
  const tool = record(value);
  if (tool === undefined || typeof tool.name !== "string" || !tool.name || !isJsonRecord(tool.inputSchema)) return undefined;
  return {
    name: tool.name,
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
  };
}

function toolName(server: string, tool: string): string | undefined {
  const name = `mcp__${server}__${tool}`;
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : undefined;
}

function mcpEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = join(home, ".config");
  env.XDG_CACHE_HOME = join(home, ".cache");
  return env;
}

function failure(request: ActionRequest, code: string, message: string): ActionResult {
  return { callId: request.callId, name: request.name, ok: false, output: { code, message } };
}

function mcpErrorMessage(result: JsonValue): string {
  const content = record(result)?.content;
  if (!Array.isArray(content)) return "the server reported an error";
  const texts = content.flatMap((item) => {
    const value = record(item);
    return value !== undefined && value.type === "text" && typeof value.text === "string" ? [value.text] : [];
  });
  return texts.join(" ") || "the server reported an error";
}

function jsonErrorMessage(value: unknown): string {
  const error = record(value);
  return error !== undefined && typeof error.message === "string"
    ? error.message
    : "unknown JSON-RPC error";
}

function record(value: unknown): { [key: string]: unknown } | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as { [key: string]: unknown } : undefined;
}

function isJsonRecord(value: unknown): value is { [key: string]: JsonValue } {
  return jsonValue(value) !== undefined && record(value) !== undefined;
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const parsed = jsonValue(item);
      if (parsed === undefined) return undefined;
      items.push(parsed);
    }
    return items;
  }
  const object = record(value);
  if (object === undefined) return undefined;
  const entries = Object.entries(object).map(([key, item]) => [key, jsonValue(item)] as const);
  if (entries.some(([, item]) => item === undefined)) return undefined;
  return Object.fromEntries(entries) as { [key: string]: JsonValue };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

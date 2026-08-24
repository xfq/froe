import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type CheckStatus = "passed" | "failed" | "pending" | "error";

interface BaseCheck {
  id: string;
  description: string;
  points: number;
}

export interface FileRegexCheck extends BaseCheck {
  type: "file_regex";
  path: string;
  pattern: string;
  flags?: string;
}

export interface FileNotRegexCheck extends BaseCheck {
  type: "file_not_regex";
  path: string;
  pattern: string;
  flags?: string;
}

export interface AllFilesRegexCheck extends BaseCheck {
  type: "all_files_regex";
  paths?: string[];
  pathPattern?: string;
  pattern: string;
  flags?: string;
  minimumFiles?: number;
}

export interface CssDeclarationCheck extends BaseCheck {
  type: "css_declaration";
  path: string;
  selector: string;
  property: string;
  equals?: string;
  contains?: string;
  absent?: boolean;
  media?: "all" | "screen" | "print";
  mediaPattern?: string;
}

export interface ChangedPathsCheck extends BaseCheck {
  type: "changed_paths";
  required: string[];
  allowedPatterns: string[];
}

export interface ManualCheck extends BaseCheck {
  type: "manual";
  instructions: string;
}

export type EvalCheck =
  | FileRegexCheck
  | FileNotRegexCheck
  | AllFilesRegexCheck
  | CssDeclarationCheck
  | ChangedPathsCheck
  | ManualCheck;

export interface EvalTask {
  id: string;
  title: string;
  difficulty: "easy" | "medium" | "hard";
  seed: string;
  prompt: string;
  checks: EvalCheck[];
}

export interface EvalSuite {
  schemaVersion: 1;
  id: string;
  title: string;
  repository: {
    url: string;
  };
  tasks: EvalTask[];
  sourcePath: string;
}

export interface CheckResult {
  id: string;
  description: string;
  status: CheckStatus;
  earnedPoints: number;
  possiblePoints: number;
  evidence: string;
}

export interface ScoreSummary {
  earnedPoints: number;
  possiblePoints: number;
  pendingPoints: number;
  percent: number | null;
}

export interface EvalResult {
  schemaVersion: 1;
  suiteId: string;
  taskId: string;
  taskTitle: string;
  seed: string;
  workspace: string;
  agentLabel?: string;
  agentCommand?: string[];
  startedAt?: string;
  finishedAt: string;
  durationMs?: number;
  agentExitCode?: number | null;
  checks: CheckResult[];
  automated: ScoreSummary;
  overall: ScoreSummary;
}

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface CssRule {
  selector: string;
  body: string;
  atRules: string[];
}

export async function loadSuite(suitePath: string): Promise<EvalSuite> {
  const sourcePath = resolve(suitePath);
  const parsed: unknown = JSON.parse(await readFile(sourcePath, "utf8"));
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported evaluation suite: ${sourcePath}`);
  }
  if (typeof parsed.id !== "string" || typeof parsed.title !== "string") {
    throw new Error(`Evaluation suite is missing id or title: ${sourcePath}`);
  }
  if (!isRecord(parsed.repository) || typeof parsed.repository.url !== "string") {
    throw new Error(`Evaluation suite is missing repository.url: ${sourcePath}`);
  }
  if (!Array.isArray(parsed.tasks)) {
    throw new Error(`Evaluation suite is missing tasks: ${sourcePath}`);
  }

  const suite = parsed as unknown as EvalSuite;
  suite.sourcePath = sourcePath;
  const ids = new Set<string>();
  for (const task of suite.tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
    const points = task.checks.reduce((sum, check) => sum + check.points, 0);
    if (points !== 100) {
      throw new Error(`${task.id} has ${points} points; every task must total 100`);
    }
  }
  return suite;
}

export function findTask(suite: EvalSuite, taskId: string): EvalTask {
  const task = suite.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown task ${taskId} in suite ${suite.id}`);
  return task;
}

export async function readTaskPrompt(
  suite: EvalSuite,
  task: EvalTask,
): Promise<string> {
  return readFile(resolve(dirname(suite.sourcePath), task.prompt), "utf8");
}

export async function prepareWorkspace(options: {
  suite: EvalSuite;
  task: EvalTask;
  workspace: string;
  cache?: string;
}): Promise<string> {
  const workspace = resolve(options.workspace);
  const cache = resolve(
    options.cache ?? join(dirname(options.suite.sourcePath), ".cache", `${options.suite.id}.git`),
  );
  await assertMissing(workspace, "Workspace already exists");
  await mkdir(dirname(cache), { recursive: true });

  if (await pathExists(cache)) {
    await requireProcess(
      "git",
      ["--git-dir", cache, "fetch", "origin"],
      dirname(options.suite.sourcePath),
    );
  } else {
    await requireProcess(
      "git",
      ["clone", "--mirror", options.suite.repository.url, cache],
      dirname(options.suite.sourcePath),
    );
  }

  await requireProcess(
    "git",
    ["--git-dir", cache, "cat-file", "-e", `${options.task.seed}^{commit}`],
    dirname(options.suite.sourcePath),
  );
  await mkdir(workspace, { recursive: true });
  await archiveCommit(cache, options.task.seed, workspace);
  await requireProcess("git", ["init", "--quiet", "--initial-branch=eval"], workspace);
  await requireProcess("git", ["config", "user.name", "Evaluation Harness"], workspace);
  await requireProcess("git", ["config", "user.email", "eval@example.invalid"], workspace);
  await requireProcess("git", ["add", "-A"], workspace);
  await requireProcess(
    "git",
    ["commit", "--quiet", "-m", `Evaluation seed ${options.task.id}`],
    workspace,
  );
  await requireProcess("git", ["update-ref", "refs/eval/baseline", "HEAD"], workspace);
  return workspace;
}

export async function gradeWorkspace(options: {
  suite: EvalSuite;
  task: EvalTask;
  workspace: string;
  manual?: ReadonlyMap<string, "pass" | "fail">;
  metadata?: Partial<EvalResult>;
}): Promise<EvalResult> {
  const workspace = resolve(options.workspace);
  await access(workspace, fsConstants.R_OK);
  const results: CheckResult[] = [];
  for (const check of options.task.checks) {
    try {
      results.push(await evaluateCheck(workspace, check, options.manual ?? new Map()));
    } catch (error) {
      results.push({
        id: check.id,
        description: check.description,
        status: "error",
        earnedPoints: 0,
        possiblePoints: check.points,
        evidence: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    schemaVersion: 1,
    suiteId: options.suite.id,
    taskId: options.task.id,
    taskTitle: options.task.title,
    seed: options.task.seed,
    workspace,
    ...options.metadata,
    finishedAt: new Date().toISOString(),
    checks: results,
    automated: summarize(results.filter((result) => result.status !== "pending" && isAutomated(options.task, result.id))),
    overall: summarize(results),
  };
}

export async function runAgent(options: {
  command: string[];
  workspace: string;
  prompt: string;
}): Promise<{ exitCode: number | null; durationMs: number }> {
  if (options.command.length === 0) throw new Error("Agent command is empty");
  const promptDirectory = await mkdtemp(join(tmpdir(), "froe-eval-prompt-"));
  const promptFile = join(promptDirectory, "task.md");
  await writeFile(promptFile, options.prompt, "utf8");
  const replacements = new Map([
    ["{workspace}", resolve(options.workspace)],
    ["{prompt}", options.prompt],
    ["{promptFile}", promptFile],
  ]);
  const expanded = options.command.map((argument) => replacements.get(argument) ?? argument);
  const executable = expanded[0];
  if (!executable) throw new Error("Agent command is empty");
  const started = Date.now();
  const result = await runProcess(executable, expanded.slice(1), resolve(options.workspace), true);
  return { exitCode: result.exitCode, durationMs: Date.now() - started };
}

export async function writeResult(
  suite: EvalSuite,
  result: EvalResult,
  resultsDirectory?: string,
): Promise<string> {
  const directory = resolve(
    resultsDirectory ?? join(dirname(suite.sourcePath), "results"),
  );
  await mkdir(directory, { recursive: true });
  const timestamp = result.finishedAt.replaceAll(/[:.]/g, "-");
  const label = safeFilename(result.agentLabel ?? "unlabelled");
  const path = join(directory, `${timestamp}-${label}-${result.taskId}.json`);
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return path;
}

export async function readResults(directory: string): Promise<EvalResult[]> {
  const entries = await readdir(resolve(directory), { withFileTypes: true });
  const results: EvalResult[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const parsed = JSON.parse(await readFile(join(resolve(directory), entry.name), "utf8"));
    if (isRecord(parsed) && parsed.schemaVersion === 1 && Array.isArray(parsed.checks)) {
      results.push(parsed as unknown as EvalResult);
    }
  }
  return results.sort((left, right) => left.finishedAt.localeCompare(right.finishedAt));
}

async function evaluateCheck(
  workspace: string,
  check: EvalCheck,
  manual: ReadonlyMap<string, "pass" | "fail">,
): Promise<CheckResult> {
  switch (check.type) {
    case "file_regex": {
      const content = await readWorkspaceFile(workspace, check.path);
      const passed = makeRegex(check.pattern, check.flags).test(content);
      return resultFor(check, passed, passed ? `Pattern found in ${check.path}` : `Pattern missing from ${check.path}`);
    }
    case "file_not_regex": {
      const content = await readWorkspaceFile(workspace, check.path);
      const passed = !makeRegex(check.pattern, check.flags).test(content);
      return resultFor(check, passed, passed ? `Forbidden pattern absent from ${check.path}` : `Forbidden pattern found in ${check.path}`);
    }
    case "all_files_regex": {
      const paths = check.paths ?? await matchingFiles(workspace, check.pathPattern ?? ".*");
      const regex = makeRegex(check.pattern, check.flags);
      const matched: string[] = [];
      const missing: string[] = [];
      for (const path of paths) {
        const content = await readWorkspaceFile(workspace, path);
        (regex.test(content) ? matched : missing).push(path);
        regex.lastIndex = 0;
      }
      const enoughFiles = paths.length >= (check.minimumFiles ?? 1);
      const passed = enoughFiles && missing.length === 0;
      const evidence = !enoughFiles
        ? `Found ${paths.length} candidate files; expected at least ${check.minimumFiles ?? 1}`
        : passed
          ? `Pattern found in all ${matched.length} files`
          : `Pattern missing from: ${missing.join(", ")}`;
      return resultFor(check, passed, evidence);
    }
    case "css_declaration": {
      const content = await readWorkspaceFile(workspace, check.path);
      const declaration = findCssDeclaration(content, check);
      const passed = check.absent
        ? declaration === undefined
        : declaration !== undefined
          && (check.equals === undefined || normalizeCssValue(declaration) === normalizeCssValue(check.equals))
          && (check.contains === undefined || normalizeCssValue(declaration).includes(normalizeCssValue(check.contains)));
      const expected = check.absent
        ? "no matching declaration"
        : check.equals ?? `a value containing ${check.contains ?? "the expected text"}`;
      return resultFor(
        check,
        passed,
        `${check.path}: ${check.selector} { ${check.property}: ${declaration ?? "<missing>"} } (expected ${expected})`,
      );
    }
    case "changed_paths": {
      const changed = await changedPaths(workspace);
      const missing = check.required.filter((path) => !changed.includes(path));
      const unexpected = changed.filter(
        (path) => !check.allowedPatterns.some((pattern) => makeRegex(pattern).test(path)),
      );
      const passed = missing.length === 0 && unexpected.length === 0;
      const details = [
        missing.length > 0 ? `missing required: ${missing.join(", ")}` : "all required paths changed",
        unexpected.length > 0 ? `unexpected: ${unexpected.join(", ")}` : "no unexpected paths",
      ];
      return resultFor(check, passed, details.join("; "));
    }
    case "manual": {
      const verdict = manual.get(check.id);
      if (!verdict) {
        return {
          id: check.id,
          description: check.description,
          status: "pending",
          earnedPoints: 0,
          possiblePoints: check.points,
          evidence: check.instructions,
        };
      }
      return resultFor(check, verdict === "pass", check.instructions);
    }
  }
}

function resultFor(check: EvalCheck, passed: boolean, evidence: string): CheckResult {
  return {
    id: check.id,
    description: check.description,
    status: passed ? "passed" : "failed",
    earnedPoints: passed ? check.points : 0,
    possiblePoints: check.points,
    evidence,
  };
}

function summarize(results: CheckResult[]): ScoreSummary {
  const earnedPoints = results.reduce((sum, result) => sum + result.earnedPoints, 0);
  const possiblePoints = results.reduce((sum, result) => sum + result.possiblePoints, 0);
  const pendingPoints = results
    .filter((result) => result.status === "pending")
    .reduce((sum, result) => sum + result.possiblePoints, 0);
  return {
    earnedPoints,
    possiblePoints,
    pendingPoints,
    percent: pendingPoints > 0 || possiblePoints === 0
      ? null
      : Math.round((earnedPoints / possiblePoints) * 1000) / 10,
  };
}

function isAutomated(task: EvalTask, checkId: string): boolean {
  return task.checks.find((check) => check.id === checkId)?.type !== "manual";
}

function findCssDeclaration(content: string, check: CssDeclarationCheck): string | undefined {
  const rules = parseCssRules(content.replaceAll(/\/\*[\s\S]*?\*\//g, ""));
  let value: string | undefined;
  for (const rule of rules) {
    if (!mediaMatches(rule.atRules, check)) continue;
    const selectors = rule.selector.split(",").map(normalizeSelector);
    if (!selectors.includes(normalizeSelector(check.selector))) continue;
    const declarations = rule.body.matchAll(/([\w-]+)\s*:\s*([^;{}]+)\s*;?/g);
    for (const declaration of declarations) {
      const property = declaration[1];
      const declarationValue = declaration[2];
      if (property && declarationValue && property.toLowerCase() === check.property.toLowerCase()) {
        value = declarationValue.trim();
      }
    }
  }
  return value;
}

function parseCssRules(content: string, atRules: string[] = []): CssRule[] {
  const rules: CssRule[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const open = findNextOutsideString(content, "{", cursor);
    if (open === -1) break;
    const headerStart = Math.max(
      content.lastIndexOf("}", open - 1),
      content.lastIndexOf(";", open - 1),
    ) + 1;
    const header = content.slice(headerStart, open).trim();
    const close = matchingBrace(content, open);
    if (close === -1) break;
    const body = content.slice(open + 1, close);
    if (/^@(media|supports|layer|container)\b/i.test(header)) {
      rules.push(...parseCssRules(body, [...atRules, header]));
    } else if (header.length > 0) {
      rules.push({ selector: header, body, atRules });
    }
    cursor = close + 1;
  }
  return rules;
}

function mediaMatches(atRules: string[], check: CssDeclarationCheck): boolean {
  const mediaRules = atRules.filter((rule) => /^@media\b/i.test(rule));
  if (check.mediaPattern && !mediaRules.some((rule) => makeRegex(check.mediaPattern ?? "").test(rule))) {
    return false;
  }
  if (check.media === "print") return mediaRules.some((rule) => /\bprint\b/i.test(rule));
  if (check.media === "screen") return !mediaRules.some((rule) => /\bprint\b/i.test(rule));
  return true;
}

function matchingBrace(content: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let index = open; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return -1;
}

function findNextOutsideString(content: string, needle: string, start: number): number {
  let quote = "";
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
    } else if (character === "\"" || character === "'") quote = character;
    else if (character === needle) return index;
  }
  return -1;
}

async function matchingFiles(workspace: string, pathPattern: string): Promise<string[]> {
  const regex = makeRegex(pathPattern);
  const files: string[] = [];
  async function visit(relative: string): Promise<void> {
    const entries = await readdir(join(workspace, relative), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && regex.test(path)) files.push(path);
      regex.lastIndex = 0;
    }
  }
  await visit("");
  return files.sort();
}

async function changedPaths(workspace: string): Promise<string[]> {
  const baseline = await requireProcess(
    "git",
    ["diff", "--name-only", "refs/eval/baseline", "--"],
    workspace,
  );
  const status = await requireProcess(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    workspace,
  );
  const worktreePaths = status.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, ""))
    .map((path) => path.includes(" -> ") ? path.slice(path.indexOf(" -> ") + 4) : path);
  const committedPaths = baseline.stdout.split("\n").filter(Boolean);
  return [...new Set([...committedPaths, ...worktreePaths])].sort();
}

async function archiveCommit(cache: string, seed: string, workspace: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const archive = spawn("git", ["--git-dir", cache, "archive", "--format=tar", seed], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const extract = spawn("tar", ["-x", "-C", workspace], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let archiveError = "";
    let extractError = "";
    archive.stderr.on("data", (chunk) => { archiveError += String(chunk); });
    extract.stderr.on("data", (chunk) => { extractError += String(chunk); });
    archive.stdout.pipe(extract.stdin);
    let archiveCode: number | null = null;
    let extractCode: number | null = null;
    const finish = (): void => {
      if (archiveCode === null || extractCode === null) return;
      if (archiveCode === 0 && extractCode === 0) resolvePromise();
      else reject(new Error(`Could not materialize seed: ${archiveError}${extractError}`.trim()));
    };
    archive.on("error", reject);
    extract.on("error", reject);
    archive.on("close", (code) => { archiveCode = code; finish(); });
    extract.on("close", (code) => { extractCode = code; finish(); });
  });
}

async function readWorkspaceFile(workspace: string, relativePath: string): Promise<string> {
  const path = resolve(workspace, relativePath);
  const canonicalWorkspace = await realpath(workspace);
  const canonicalPath = await realpath(path);
  if (canonicalPath !== canonicalWorkspace && !canonicalPath.startsWith(`${canonicalWorkspace}/`)) {
    throw new Error(`Check path escapes workspace: ${relativePath}`);
  }
  return readFile(canonicalPath, "utf8");
}

async function requireProcess(command: string, args: string[], cwd: string): Promise<ProcessResult> {
  const result = await runProcess(command, args, cwd, false);
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result;
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  inherit: boolean,
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!inherit) {
      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    }
    child.on("error", reject);
    child.on("close", (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
  });
}

async function assertMissing(path: string, prefix: string): Promise<void> {
  if (await pathExists(path)) throw new Error(`${prefix}: ${path}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function makeRegex(pattern: string, flags = "m"): RegExp {
  return new RegExp(pattern, flags);
}

function normalizeSelector(selector: string): string {
  return selector.trim().replaceAll(/\s+/g, " ");
}

function normalizeCssValue(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

function safeFilename(value: string): string {
  return basename(value).replaceAll(/[^a-zA-Z0-9._-]+/g, "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

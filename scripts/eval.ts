#!/usr/bin/env node

import { join, resolve } from "node:path";
import {
  findTask,
  gradeWorkspace,
  loadSuite,
  prepareWorkspace,
  readResults,
  readTaskPrompt,
  runAgent,
  writeResult,
  type EvalResult,
} from "./eval-lib.js";

const DEFAULT_SUITE = "evals/i18n-drafts/suite.json";

interface ParsedArguments {
  options: Map<string, string[]>;
  command: string[];
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === "--") arguments_.shift();
  const [subcommand, ...rawArguments] = arguments_;
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }
  const parsed = parseArguments(rawArguments);
  if (subcommand === "report") {
    await report(requireOption(parsed, "results"));
    return;
  }

  const suite = await loadSuite(option(parsed, "suite") ?? DEFAULT_SUITE);
  if (subcommand === "list") {
    console.log(`${suite.title} (${suite.id})`);
    for (const task of suite.tasks) {
      console.log(`${task.id.padEnd(9)} ${task.difficulty.padEnd(6)} ${task.title}`);
    }
    return;
  }
  if (subcommand === "run-all") {
    if (parsed.command.length === 0) {
      throw new Error("run-all requires an agent command after --");
    }
    const root = resolve(
      option(parsed, "workspace-root")
        ?? join("evals", "workspaces", `${suite.id}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`),
    );
    let failedAgents = 0;
    for (const task of suite.tasks) {
      console.log(`\n=== ${task.id}: ${task.title} ===`);
      const workspace = join(root, task.id);
      const cache = option(parsed, "cache");
      const agentLabel = option(parsed, "agent");
      const prepared = await prepareWorkspace({
        suite,
        task,
        workspace,
        ...(cache ? { cache } : {}),
      });
      const prompt = await readTaskPrompt(suite, task);
      const startedAt = new Date().toISOString();
      const agent = await runAgent({ command: parsed.command, workspace: prepared, prompt });
      const result = await gradeWorkspace({
        suite,
        task,
        workspace: prepared,
        metadata: {
          ...(agentLabel ? { agentLabel } : {}),
          agentCommand: parsed.command,
          startedAt,
          durationMs: agent.durationMs,
          agentExitCode: agent.exitCode,
        },
      });
      const path = await writeResult(suite, result, option(parsed, "results"));
      console.log(`Automated: ${scoreText(result.automated)} · Overall: ${scoreText(result.overall)}`);
      console.log(`Result: ${path}`);
      if (agent.exitCode !== 0) failedAgents += 1;
    }
    if (failedAgents > 0) process.exitCode = 1;
    return;
  }

  const task = findTask(suite, requireOption(parsed, "task"));
  if (subcommand === "prompt") {
    process.stdout.write(await readTaskPrompt(suite, task));
    return;
  }
  if (subcommand === "prepare") {
    const cache = option(parsed, "cache");
    const workspace = await prepareWorkspace({
      suite,
      task,
      workspace: option(parsed, "workspace") ?? defaultWorkspace(suite.id, task.id),
      ...(cache ? { cache } : {}),
    });
    console.log(workspace);
    return;
  }
  if (subcommand === "grade") {
    const agentLabel = option(parsed, "agent");
    const result = await gradeWorkspace({
      suite,
      task,
      workspace: requireOption(parsed, "workspace"),
      manual: manualVerdicts(parsed),
      metadata: agentLabel ? { agentLabel } : {},
    });
    const path = await writeResult(suite, result, option(parsed, "results"));
    printGrade(result, path);
    return;
  }
  if (subcommand === "run") {
    if (parsed.command.length === 0) {
      throw new Error("run requires an agent command after --");
    }
    const cache = option(parsed, "cache");
    const agentLabel = option(parsed, "agent");
    const workspace = await prepareWorkspace({
      suite,
      task,
      workspace: option(parsed, "workspace") ?? defaultWorkspace(suite.id, task.id),
      ...(cache ? { cache } : {}),
    });
    const prompt = await readTaskPrompt(suite, task);
    const startedAt = new Date().toISOString();
    const agent = await runAgent({ command: parsed.command, workspace, prompt });
    const result = await gradeWorkspace({
      suite,
      task,
      workspace,
      manual: manualVerdicts(parsed),
      metadata: {
        ...(agentLabel ? { agentLabel } : {}),
        agentCommand: parsed.command,
        startedAt,
        durationMs: agent.durationMs,
        agentExitCode: agent.exitCode,
      },
    });
    const path = await writeResult(suite, result, option(parsed, "results"));
    printGrade(result, path);
    if (agent.exitCode !== 0) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown eval command: ${subcommand}`);
}

function parseArguments(arguments_: string[]): ParsedArguments {
  const separator = arguments_.indexOf("--");
  const optionArguments = separator === -1 ? arguments_ : arguments_.slice(0, separator);
  const command = separator === -1 ? [] : arguments_.slice(separator + 1);
  const options = new Map<string, string[]>();
  for (let index = 0; index < optionArguments.length; index += 1) {
    const name = optionArguments[index];
    const value = optionArguments[index + 1];
    if (name === undefined || !name.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Expected --name value, received: ${name}`);
    }
    const key = name.slice(2);
    options.set(key, [...(options.get(key) ?? []), value]);
    index += 1;
  }
  return { options, command };
}

function option(parsed: ParsedArguments, name: string): string | undefined {
  return parsed.options.get(name)?.at(-1);
}

function requireOption(parsed: ParsedArguments, name: string): string {
  const value = option(parsed, name);
  if (!value) throw new Error(`Missing required option --${name}`);
  return value;
}

function manualVerdicts(parsed: ParsedArguments): Map<string, "pass" | "fail"> {
  const verdicts = new Map<string, "pass" | "fail">();
  for (const value of parsed.options.get("manual") ?? []) {
    const [id, verdict, extra] = value.split("=");
    if (!id || extra !== undefined || (verdict !== "pass" && verdict !== "fail")) {
      throw new Error(`Manual verdict must be CHECK_ID=pass or CHECK_ID=fail: ${value}`);
    }
    verdicts.set(id, verdict);
  }
  return verdicts;
}

function defaultWorkspace(suiteId: string, taskId: string): string {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  return resolve("evals", "workspaces", `${suiteId}-${taskId}-${stamp}`);
}

function printGrade(result: EvalResult, path: string): void {
  for (const check of result.checks) {
    console.log(`${check.status.padEnd(7)} ${String(check.earnedPoints).padStart(3)}/${check.possiblePoints} ${check.id}: ${check.description}`);
    if (check.status !== "passed") console.log(`          ${check.evidence}`);
  }
  console.log(`Automated: ${scoreText(result.automated)}`);
  console.log(`Overall:   ${scoreText(result.overall)}`);
  console.log(`Result:    ${path}`);
}

function scoreText(score: EvalResult["overall"]): string {
  return score.percent === null
    ? `${score.earnedPoints}/${score.possiblePoints} (${score.pendingPoints} points pending)`
    : `${score.earnedPoints}/${score.possiblePoints} (${score.percent}%)`;
}

async function report(directory: string): Promise<void> {
  const results = await readResults(directory);
  if (results.length === 0) {
    console.log("No evaluation result files found.");
    return;
  }
  console.log("agent\ttask\tautomated\toverall\tduration_s\tfinished");
  for (const result of results) {
    console.log([
      result.agentLabel ?? "unlabelled",
      result.taskId,
      scoreText(result.automated),
      scoreText(result.overall),
      result.durationMs === undefined ? "" : (result.durationMs / 1000).toFixed(1),
      result.finishedAt,
    ].join("\t"));
  }
}

function printUsage(): void {
  console.log(`Usage:
  pnpm eval -- list [--suite path]
  pnpm eval -- prompt --task ID [--suite path]
  pnpm eval -- prepare --task ID [--workspace path] [--cache path]
  pnpm eval -- grade --task ID --workspace path [--agent label] [--manual ID=pass|fail]
  pnpm eval -- run --task ID [--workspace path] [--agent label] -- executable ...
  pnpm eval -- run-all [--workspace-root path] [--agent label] -- executable ...
  pnpm eval -- report --results path

The run command replaces an argument that is exactly {workspace}, {prompt}, or {promptFile}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

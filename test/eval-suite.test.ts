import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  findTask,
  gradeWorkspace,
  loadSuite,
  prepareWorkspace,
  runAgent,
  type EvalSuite,
  type EvalTask,
} from "../scripts/eval-lib.js";

const execFileAsync = promisify(execFile);

test("the i18n suite has unique 100-point tasks and readable prompts", async () => {
  const suite = await loadSuite("evals/i18n-drafts/suite.json");
  assert.equal(suite.tasks.length, 7);
  assert.equal(findTask(suite, "TYPE-01").difficulty, "medium");
  for (const task of suite.tasks) {
    assert.equal(task.checks.reduce((sum, check) => sum + check.points, 0), 100);
    const prompt = await readFile(join("evals/i18n-drafts", task.prompt), "utf8");
    assert.match(prompt, /^# /);
  }
});

test("prepare creates a one-commit workspace without the source remote or later history", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-eval-prepare-"));
  const source = join(root, "source");
  const workspace = join(root, "workspace");
  await mkdir(source);
  await git(source, "init", "--quiet", "--initial-branch=main");
  await git(source, "config", "user.name", "Test");
  await git(source, "config", "user.email", "test@example.invalid");
  await writeFile(join(source, "state.txt"), "seed\n", "utf8");
  await git(source, "add", "state.txt");
  await git(source, "commit", "--quiet", "-m", "seed");
  const seed = (await git(source, "rev-parse", "HEAD")).trim();
  await writeFile(join(source, "state.txt"), "later answer\n", "utf8");
  await git(source, "commit", "--quiet", "-am", "answer");

  const task = taskWithChecks(seed, []);
  const suite = suiteFor(source, task, join(root, "suite.json"));
  await prepareWorkspace({ suite, task, workspace });

  assert.equal(await readFile(join(workspace, "state.txt"), "utf8"), "seed\n");
  assert.equal((await git(workspace, "rev-list", "--count", "HEAD")).trim(), "1");
  assert.equal((await git(workspace, "remote")).trim(), "");
  assert.equal((await git(workspace, "rev-parse", "refs/eval/baseline")).trim(), (await git(workspace, "rev-parse", "HEAD")).trim());
  assert.equal((await git(workspace, "status", "--porcelain")).trim(), "");
});

test("grading uses the final screen declaration, tracks scope, and leaves manual points pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-eval-grade-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "style"), { recursive: true });
  await git(workspace, "init", "--quiet", "--initial-branch=eval");
  await git(workspace, "config", "user.name", "Test");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await writeFile(
    join(workspace, "style/article.css"),
    "a:visited { color: #036; }\n@media print { a:visited { color: #666; } }\n",
    "utf8",
  );
  await git(workspace, "add", "-A");
  await git(workspace, "commit", "--quiet", "-m", "seed");
  await git(workspace, "update-ref", "refs/eval/baseline", "HEAD");
  await writeFile(
    join(workspace, "style/article.css"),
    "a:visited { color: #036; }\na:visited { color: brown; }\n@media print { a:visited { color: #666; } }\n",
    "utf8",
  );

  const task = taskWithChecks("seed", [
    {
      type: "css_declaration",
      id: "color",
      description: "screen color",
      points: 60,
      path: "style/article.css",
      selector: "a:visited",
      property: "color",
      equals: "brown",
      media: "screen",
    },
    {
      type: "changed_paths",
      id: "scope",
      description: "scope",
      points: 20,
      required: ["style/article.css"],
      allowedPatterns: ["^style/article\\.css$"],
    },
    {
      type: "manual",
      id: "visual",
      description: "visual review",
      points: 20,
      instructions: "Inspect the page.",
    },
  ]);
  const suite = suiteFor(root, task, join(root, "suite.json"));

  const pending = await gradeWorkspace({ suite, task, workspace });
  assert.equal(pending.automated.percent, 100);
  assert.equal(pending.overall.percent, null);
  assert.equal(pending.overall.pendingPoints, 20);

  const complete = await gradeWorkspace({
    suite,
    task,
    workspace,
    manual: new Map([["visual", "pass"]]),
  });
  assert.equal(complete.overall.percent, 100);

  await git(workspace, "add", "style/article.css");
  await git(workspace, "commit", "--quiet", "-m", "agent committed the fix");
  const committed = await gradeWorkspace({ suite, task, workspace });
  assert.equal(committed.checks.find((check) => check.id === "scope")?.status, "passed");
});

test("the agent adapter passes exact prompt and workspace arguments without a shell", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "froe-eval-adapter-"));
  const prompt = "Fix the real styling problem.";
  const result = await runAgent({
    workspace,
    prompt,
    command: [
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync('adapter.txt', process.cwd() + '\\n' + process.argv[1])",
      "{prompt}",
    ],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(
    await readFile(join(workspace, "adapter.txt"), "utf8"),
    `${await realpath(workspace)}\n${prompt}`,
  );
});

function suiteFor(repository: string, task: EvalTask, sourcePath: string): EvalSuite {
  return {
    schemaVersion: 1,
    id: "fixture",
    title: "Fixture suite",
    repository: { url: repository },
    tasks: [task],
    sourcePath,
  };
}

function taskWithChecks(seed: string, checks: EvalTask["checks"]): EvalTask {
  return {
    id: "FIXTURE-01",
    title: "Fixture task",
    difficulty: "easy",
    seed,
    prompt: "task.md",
    checks,
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout;
}

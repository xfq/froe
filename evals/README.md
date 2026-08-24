# Coding-agent evaluations

This directory contains repeatable, agent-neutral coding evaluations. The first suite replays seven real styling and accessibility fixes from `w3c/i18n-drafts`.

## What makes a useful evaluation task

Each active task has the following properties:

1. **A real user-visible problem.** The task came from an upstream change or issue.
2. **A frozen starting point.** A full Git commit identifies the exact code and constraints the agent receives.
3. **A self-contained brief.** The prompt explains the desired outcome without revealing the historical patch.
4. **Outcome checks.** Automated checks inspect the resulting behavior and changed-file scope. They do not require an exact diff.
5. **Human review.** Typography, responsive layout, bidi behavior, and interaction quality retain an explicit visual or keyboard score.
6. **A calibration reference.** A known historical fix proves the task was solvable and helps maintainers test the grader. References remain outside prepared workspaces.

Do not promote a candidate task until two independent reasonable implementations can pass its checks. A grader that accepts only the historical patch is measuring imitation; a grader that accepts a one-line textual trick is measuring the checker rather than the product behavior.

## Seed terminology

An evaluation seed is the full Git commit id that fixes a task's starting version, normally the commit immediately before the real problem was repaired.

The **seed tree** is the directory and file snapshot referenced by that commit. It contains the source content and file modes at that point, but the exported snapshot does not carry the commit's parents, message, branches, tags, later commits, or remote URL.

`prepare` turns the seed tree into a **prepared workspace** by importing it into a new Git repository with one baseline commit. Thus the seed identifies which source version to use, the seed tree is the source content taken from that version, and the prepared workspace is the isolated repository given to the coding agent.

## Isolation model

`prepare` mirrors the source repository into the ignored cache, exports the seed tree, and initializes a fresh repository with one baseline commit plus an evaluator baseline ref. The prepared workspace has no source remote and no later history. Existing paths are never overwritten. The baseline ref lets scope checks keep working if an agent commits its solution.

The agent adapter is deliberately only an executable plus arguments. The runner replaces arguments that are exactly:

- `{workspace}` with the fresh workspace path;
- `{prompt}` with the task text;
- `{promptFile}` with a temporary file containing the task text.

Leave these placeholders unchanged when copying a `run` or `run-all` example; you do not substitute paths or task text yourself. The surrounding single quotes are shell quoting: they keep each placeholder as one literal argument and are removed before the runner receives it. The runner then performs the substitution. For example:

```sh
froe --workspace '{workspace}' '{prompt}'
```

is executed as if it were:

```sh
froe --workspace /generated/eval-workspace "The complete task description..."
```

When adapting the command for another coding agent, change that agent's executable and flags but retain the placeholders where it expects its working directory and task. Each placeholder must be a complete argument. Forms such as `--workspace={workspace}` are not replaced.

The command runs with the prepared workspace as its current directory. The harness does not impose a network or filesystem sandbox around third-party agents. For comparable, leak-resistant runs, configure each agent so it can access only `{workspace}`, cannot read this suite's `REFERENCES.md`, and cannot search upstream history or the issue solution online. Froe's `--workspace` boundary provides the filesystem side of that contract.

Do not place credentials in adapter arguments because the argument template is retained in the result record. Supply credentials through the agent's normal protected environment or credential store.

## Commands

List the active tasks:

```sh
pnpm eval -- list
```

Prepare a task for manual use with any agent:

```sh
pnpm eval -- prepare --task LINK-01 --workspace /tmp/link-01
pnpm eval -- prompt --task LINK-01
```

After the agent edits the workspace, grade it. Automated points are reported immediately; the overall score stays pending until the named manual check is recorded:

```sh
pnpm eval -- grade --task LINK-01 --workspace /tmp/link-01 --agent froe
pnpm eval -- grade --task LINK-01 --workspace /tmp/link-01 --agent froe \
  --manual visual-states=pass
```

Run one task through an installed Froe executable:

```sh
pnpm eval -- run --task LINK-01 --agent froe -- \
  froe --workspace '{workspace}' '{prompt}'
```

Run all active tasks sequentially through the same adapter:

```sh
pnpm eval -- run-all --agent froe -- \
  froe --workspace '{workspace}' '{prompt}'
```

An agent that expects a prompt path can use `{promptFile}`. Keep each token as its own argument; the runner never invokes a shell and does not interpolate tokens inside a longer argument.

Results are ignored JSON files under `evals/i18n-drafts/results/` by default. Compare accumulated runs with:

```sh
pnpm eval -- report --results evals/i18n-drafts/results
```

## Periodic comparison protocol

For each evaluation round:

1. Pin the agent version, model, reasoning setting, time limit, and approval policy.
2. Run every task from a new prepared workspace. Use the same environment and task order policy for every agent.
3. Repeat each agent/task pair at least three times when measuring a stochastic model. Report full-pass rate and median score/duration, not only the best run.
4. Have a reviewer who does not know the agent label complete the manual checks from the recorded instructions.
5. Keep old result JSON. If upstream evolution requires a new seed or rubric, create a versioned task id rather than changing the meaning of old scores.
6. Review failures qualitatively. A useful suite should tell you whether the agent misunderstood the problem, changed too much, failed to verify, or produced a visual/accessibility regression.

The score is diagnostic rather than a single universal ranking. Report automated score, completed manual score, full-task pass rate, duration, and any user intervention separately. Static checks are intentionally only part of tasks where browser rendering or keyboard interaction is the real acceptance boundary.

## Adding a task

Add a prompt under the suite's `tasks/` directory and a manifest entry whose checks total 100 points. Prefer a seed immediately before the relevant fix. Add the historical reference only to the evaluator reference file. Test these cases before activation:

- the unchanged seed fails for the intended reason;
- the known-good solution passes automated checks;
- an unrelated-file change fails the scope check;
- at least one plausible alternative solution passes;
- the manual instructions name exact pages, viewport sizes, locales, and interactions.

Open-ended problems whose expected behavior is still under discussion belong in `CANDIDATES.md`, not in the scored suite.

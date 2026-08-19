# Architecture

This document describes the architecture implemented in the repository. Source code remains authoritative, and architecture-affecting changes must update this document.

For consequential decisions and their trade-offs, see the [architecture decision records](./docs/adr/).

## Purpose and boundaries

Froe is a single-process TypeScript command-line coding agent. A CLI invocation either creates one bounded **run** or hosts an interactive conversation whose messages create sequential bounded runs against one user-authorized **workspace**. During a run, a model can inspect files, apply precise text changes, execute validation commands, and report a verified outcome.

Inspectability is a product property: after a run, a person must be able to determine the action sequence, safe summaries of its effects or results, applicable approval decisions, and the reason for its final outcome. Metadata recording deliberately excludes source contents, patch bodies, tool output, and model text.

The current implementation has a small boundary:

- one task and one model provider per run, with one provider reused across the runs in an interactive conversation;
- one production provider, the OpenAI Responses API, behind a provider-neutral interface;
- local, workspace-scoped actions;
- automatic macOS Seatbelt containment for spawned commands, with interactive approval for narrow exceptions;
- in-memory model continuation state, with an optional append-only invocation record outside the workspace;
- no resume protocol or long-lived daemon.

## System overview

The CLI is the composition root. The conversation module sequences user messages into bounded runs while preserving one model provider and action runtime. Its terminal adapter owns line editing and Tab completion for the supported slash commands: `/init`, which remains a normal run task, and `/exit`, which closes the conversation without a run. The three deepest modules remain the run loop, which owns model/action orchestration and completion semantics; the action runtime, which owns workspace effects and approval policy; and the command sandbox, which owns child-process containment and lifecycle. Provider-specific translation, persistence, configuration, credentials, and project-instruction discovery sit behind smaller seams.

## Action runtime

The model sees six actions. Their JSON schemas and implementations live together in [`src/action-runtime.ts`](./src/action-runtime.ts).

| Action | Behavior |
| --- | --- |
| `list_files` | Lists one directory level, sorted, while hiding symlinks and ignored directories. |
| `read_file` | Reads bounded lines and bytes from one UTF-8 text file. |
| `search` | Performs literal, case-sensitive search with `rg`; falls back to a Node traversal if `rg` is unavailable or unusable. |
| `apply_patch` | Creates, replaces, or deletes UTF-8 text files through exact-match changes. A batch validates before mutation and stages writes before replacement. |
| `run_command` | Runs one executable with an argument array through `CommandSandbox`, with a workspace-contained working directory, bounded output, and a timeout. It never invokes a shell implicitly. |
| `finish` | Parses the model's proposed outcome; the run loop performs the final semantic checks. |

### Approval boundary

Read-only file actions and `finish` do not require approval. Deletion through `apply_patch` is always classified as destructive.

Known destructive executables and Git subcommands that can discard changes require destructive approval before execution. Other commands run automatically inside the command sandbox. Deletion through `apply_patch` remains independently approval-gated.

## Configuration, credentials, and retained data

### Configuration precedence and authority

Configuration merges from lowest to highest precedence:

1. built-in defaults from [`src/config.ts`](./src/config.ts);
2. user configuration at `$XDG_CONFIG_HOME/froe/config.json`, or `~/.config/froe/config.json`;
3. workspace configuration at `.froe/config.json`;
4. an explicit user-controlled file passed with `--config`;
5. CLI overrides.

## Testing strategy

The automated suite tests behavior at the deepest public seams:

- [`test/run.test.ts`](./test/run.test.ts) drives complete runs with `ScriptedModel`, including patching, approval denial, `/init`, and completion evidence;
- [`test/conversation.test.ts`](./test/conversation.test.ts) sends multiple user messages through sequential runs and verifies follow-up context;
- [`test/cli.test.ts`](./test/cli.test.ts) verifies slash-command completion, follow-up terminal input, and releasing the input stream before a run can request approval;
- [`test/action-runtime.test.ts`](./test/action-runtime.test.ts) exercises patch preflight, workspace confinement, symlink rejection, search results, command timeouts, environment filtering, and workspace configuration restrictions;
- [`test/command-sandbox.test.ts`](./test/command-sandbox.test.ts) exercises the real macOS Seatbelt adapter;
- [`test/openai-provider.test.ts`](./test/openai-provider.test.ts) uses a local fake HTTP server to verify Responses API translation and client-side continuation without a real API call;
- [`test/credentials.test.ts`](./test/credentials.test.ts) verifies credential precedence, prompting, migration, validation, and file permissions.

The normal local validation sequence is:

```sh
pnpm typecheck
pnpm test
pnpm build
```

`pnpm smoke:openai` is an opt-in external integration check and requires real credentials.

## Evolution rules

Keep this file descriptive rather than aspirational. When implementation changes any of the following, update the corresponding section here in the same change:

- module responsibilities or dependencies;
- startup, run, action, cancellation, or completion flow;
- action schemas, workspace constraints, approval policy, or command execution;
- configuration precedence or authority boundaries;
- credential, instruction, or provider-state handling;
- persisted paths, external integrations, or validation strategy.

Pure implementation changes that do not alter these architectural facts do not need a ceremonial edit.

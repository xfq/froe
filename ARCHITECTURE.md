# Architecture

This document describes the architecture implemented in the repository. Source code remains authoritative, and architecture-affecting changes must update this document.

For consequential decisions and their trade-offs, see the [architecture decision records](./docs/adr/).

## Purpose and boundaries

Froe is a single-process TypeScript coding agent distributed through two public interfaces. **Froe core** is the adapter-independent runtime published as `@xfq/froe/core`; it owns session and run behavior, action execution, safety policy, configuration, integrations, and records. **Froe CLI** is the terminal application published as the `froe` command; it owns command-line parsing, terminal rendering, credential and approval prompts, and interactive input.

Froe CLI is a presentation adapter over Froe core. A core session owns one user-authorized **workspace** and hosts sequential bounded **runs** while preserving provider continuation, action authority, MCP connections, and recording state. A CLI invocation either creates one run or uses terminal input to submit multiple runs through the same session. During a run, a model can inspect files, apply precise text changes, execute validation commands, and report a verified outcome.

Inspectability is a product property: after a run, a person must be able to determine the action sequence, safe summaries of its effects or results, applicable approval decisions, and the reason for its final outcome. Metadata recording deliberately excludes source contents, patch bodies, tool output, and model text.

The current implementation has a small boundary:

- one task per run, with one model provider reused across the sequential runs in a session;
- one production provider, the OpenAI Responses API, behind a provider-neutral interface;
- local actions scoped to one Workspace and explicitly declared additional directories, plus Tavily web search;
- user-configured local stdio and remote Streamable HTTP MCP servers;
- automatic macOS Seatbelt containment for spawned commands, with interactive approval for narrow exceptions;
- per-Workspace resumable conversation history persisted outside the workspace for interactive sessions, bounded by provider-generated compaction checkpoints, plus an optional append-only invocation record outside the workspace;
- no long-lived daemon.

## System overview

In this document, *Froe core* means all adapter-independent behavior centered on `FroeSession`, not only the file named [`src/core.ts`](./src/core.ts). That file is the public package facade for the core. [`src/cli.ts`](./src/cli.ts) is the executable Froe CLI entry point.

The session composition module is the product composition root. It resolves credentials, creates the run recorder, approval gate, command sandbox, action runtime, project instructions, skills discovery, provider, Tavily adapter, and MCP manager, then returns the public `FroeSession` interface. The published Froe core subpath loads configuration before entering that composition. Froe CLI resolves the same configuration early only because npm-managed update checks must happen before session startup; it then becomes a terminal adapter over `FroeSession`.

Froe CLI reads user-selected PNG, JPEG, WEBP, or non-animated GIF paths from repeatable `--image` options and accepts repeatable `--add-dir` paths that extend the session's explicit filesystem authority alongside its primary Workspace. The shared session implementation loads and validates attachments. Its terminal conversation adapter passes command-line attachments only to the first submitted run, owns line editing and Tab completion for `/init`, `/mcp`, `/model`, `/new`, and `/exit`, and maps those controls to session operations. It assigns each submitted task a terminal-local, increasing conversation-turn number; the terminal renderer repeats that number in the task heading and all output from the corresponding Run, using labeled, indented text-response blocks while nesting Action activity beneath them. This preserves message-to-answer context in a long transcript without making tool activity compete with model text. Until a visible response event arrives, it shows a turn-numbered working indicator, animated in an interactive terminal and retained as a status line elsewhere. The MCP manager starts user-configured stdio servers or connects to remote Streamable HTTP endpoints, discovers their tools, names them `mcp__<server>__<tool>`, and routes model calls back to their owner. The four deepest modules are the session, which owns cross-run composition and lifecycle; the run loop, which owns model/action orchestration and completion semantics; the action runtime, which owns authorized-directory effects and approval policy; and the command sandbox, which owns child-process containment and lifecycle. The Tavily adapter owns its HTTP boundary and response normalization. Provider-specific translation, persistence, configuration, credentials, automatic updates, project-instruction discovery, and agent-skill discovery sit behind smaller seams.

The OpenAI adapter requests server-side context compaction at a user-selected threshold. When the provider returns a compaction item, the adapter replaces all earlier continuation input with the checkpoint and subsequent output items, then emits a provider-neutral audit event with counts and the configured threshold.

### Froe core public interface

The package exports `@xfq/froe/core` as the only supported application interface. `openFroeSession` hides configuration, credentials, provider, runtime, sandbox, MCP, instruction, and recorder composition, and can be asked to resume a persisted conversation. The returned session has three core operations: inspect serializable status, run one task, and close; interactive adapters may additionally call an optional `resetConversation` operation that drops the model's continuation context and any persisted history. A session fixes its Workspace and additional authorized directories for its lifetime, rejects concurrent runs rather than queueing them, and closes its MCP connections after cancelling any active run. `configureFroe` owns the non-run configuration operations shared by terminal and graphical adapters. Presentation adapters reuse `summarizeAction` and `redactSensitiveText` from the same interface so action summaries omit source and search contents and apply the same credential-pattern redaction as the terminal adapter.

## Action runtime

The model sees seven local actions. Their JSON schemas and implementations live together in [`src/action-runtime.ts`](./src/action-runtime.ts).

| Action | Behavior |
| --- | --- |
| `list_files` | Lists one directory level, sorted, while hiding symlinks and ignored directories. It accepts Workspace-relative paths or absolute paths beneath a declared additional directory. |
| `read_file` | Reads bounded lines and bytes from one UTF-8 text file in an authorized directory. |
| `search` | Performs literal, case-sensitive search with `rg`; falls back to a Node traversal if `rg` is unavailable or unusable. |
| `web_search` | Sends a bounded query to Tavily's Search API and returns normalized title, URL, excerpt, and score fields. The adapter in [`src/tavily-web-search.ts`](./src/tavily-web-search.ts) receives a key resolved from Froe's private credential file or `TAVILY_API_KEY`. |
| `apply_patch` | Creates, replaces, or deletes UTF-8 text files in authorized directories through exact-match changes. A batch validates before mutation and stages writes before replacement. |
| `run_command` | Runs one executable with an argument array through `CommandSandbox`, with an authorized-directory working directory, bounded output, and a timeout. On macOS the child receives a temporary `HOME` and can read only the Workspace, declared additional directories, temporary directory, system runtime, and resolved supported toolchains. It never invokes a shell implicitly. |
| `finish` | Parses the model's proposed outcome; the run loop performs the final semantic checks. |

### Approval boundary

Read-only file actions, `web_search`, and `finish` do not require approval. `web_search` sends its query to Tavily and may consume API credits. Its action summary and metadata record do not retain the query or search response. Deletion through `apply_patch` is always classified as destructive.

Known destructive executables and Git subcommands that can discard changes require destructive approval before execution. Other commands run automatically inside the command sandbox. Deletion through `apply_patch` remains independently approval-gated.

### MCP tools

`froe mcp add <name> -- <command> [args...]` writes a local stdio server definition to user configuration, while `froe mcp add <name> --url <url>` writes a remote Streamable HTTP endpoint. At startup, [`src/mcp.ts`](./src/mcp.ts) gives every configured process a temporary home, cache, and minimal environment, sends MCP JSON-RPC initialization, then follows `tools/list` pagination. Remote clients send one HTTP POST per JSON-RPC message, preserve a returned MCP session ID, accept JSON and SSE responses, and send DELETE when closing a session. Each valid tool schema becomes a namespaced model function; `tools/call` results are returned as ordinary action results for the next model turn. Pending tool calls observe run cancellation, immediately discard their pending response, and ignore any result that arrives afterward. `/mcp` reports the servers that completed discovery and their exposed tool count. Startup failures are reported and leave the server inactive without blocking the run.

An MCP server is chosen by the user, not a Workspace action. A local server is executable code and a remote server receives MCP requests. Both are outside the action runtime's filesystem containment and approval boundary; only user-controlled configuration and explicit `--config` files may define them. Froe does not pass its OpenAI or Tavily connection values to either transport.

## Configuration, credentials, and retained data

### Configuration precedence and authority

Configuration merges from lowest to highest precedence:

1. built-in defaults from [`src/config.ts`](./src/config.ts);
2. user configuration at `$XDG_CONFIG_HOME/froe/config.json`, or `~/.config/froe/config.json`;
3. workspace configuration at `.froe/config.json`;
4. an explicit user-controlled file passed with `--config`;
5. CLI overrides.

Automatic updates are enabled by default and can be disabled only by user configuration or the invocation's `--no-update` flag. MCP server definitions are likewise user-controlled: `mcpServers` may appear in user configuration or an explicit configuration file but never in Workspace configuration. Workspace configuration cannot control installation behavior or start external MCP programs.

### Tavily credential boundary

Tavily is optional and is enabled after `froe --configure-tavily` saves its key in `$XDG_CONFIG_HOME/froe/credentials.json`, or `~/.config/froe/credentials.json`. The credential file is owner-only; a configured OpenAI connection and Tavily key are preserved together. `TAVILY_API_KEY` overrides the saved key for one process. The key is neither read from workspace configuration nor passed to spawned commands, even if `commandEnv` names it. Search requests use an Authorization header, avoid requesting generated answers, images, or raw page content, and cap a returned source excerpt at 4,000 characters.

### Automatic updates

[`src/updater.ts`](./src/updater.ts) owns update throttling, stable semantic-version comparison, npm installation detection, registry lookup, and installation. It checks at most once every 24 hours and only changes a real npm global package directory matching the running package. Source checkouts, `npx` caches, linked packages, and installations managed by another mechanism are skipped. The current invocation is already loaded and continues with its starting version after a successful update; the next invocation uses the new package. A check or installation failure is reported to the terminal and does not block the coding task.

### Model continuation and compaction

The OpenAI adapter sends `store: false` and requests server-side compaction at 200,000 tokens by default. `/model <model-id>` changes only the active provider request model in the current process; it preserves continuation input and does not persist a configuration override. When a response contains a compaction checkpoint, the adapter discards all earlier in-memory continuation items and retains the checkpoint plus subsequent output. The emitted `context_compacted` event contains only the previous and retained item counts and the configured threshold. Neither the opaque checkpoint nor source-bearing model history is written to terminal output or the run record.

### Conversation history

Interactive CLI conversations opt into resumable per-Workspace history at composition time. The `ConversationHistoryStore` maps a Workspace path to an owner-only JSON file at `$XDG_STATE_HOME/froe/conversations/<sha256(workspace)>.json`, or `~/.local/state/froe/conversations/` by default, storing a versioned envelope with the Workspace path and the provider's serialized continuation items. Loading happens before provider construction; saving happens after each `run_finished` event through an adapter wrapper in the composition root. Attached image bytes are stripped on export because they belong only to the invocation that supplied them. The file deliberately retains source-bearing tool output and model text because those items are the model context being resumed; it is owner-only and never written into the Workspace. A missing, unreadable, or foreign history file starts fresh, and a failed save is swallowed so it cannot turn a completed run into a reported failure. `/new` resets the provider's continuation and clears the file through the session's optional `resetConversation` operation.

### Prompt attachments

The session validates image paths before a run, and the OpenAI provider encodes accepted attachments as base64 `input_image` content alongside the prompt text. Attachments belong only to the run that supplied them and enter only its first model turn. Attachment bytes and paths remain only in the in-memory model context. They are absent from run events and their local records.

## Testing strategy

The automated suite tests behavior at the deepest public seams:

- [`test/skills.test.ts`](./test/skills.test.ts) verifies Agent Skills discovery, frontmatter parsing, specification validation, priority resolution, and progressive-disclosure prompt formatting;
- [`test/run.test.ts`](./test/run.test.ts) drives complete runs with `ScriptedModel`, including patching, approval denial, `/init`, and completion evidence;
- [`test/session.test.ts`](./test/session.test.ts) exercises the public session behavior through sequential runs, ordered event envelopes, structured approval, and concurrency rejection;
- [`test/conversation.test.ts`](./test/conversation.test.ts) verifies that terminal conversation controls adapt to the session interface without rebuilding run behavior;
- [`test/terminal-renderer.test.ts`](./test/terminal-renderer.test.ts) verifies that an interactive task, its waiting indicator, and its answer, actions, and outcome share one terminal-local conversation-turn number;
- [`test/cli.test.ts`](./test/cli.test.ts) verifies slash-command completion, model-command parsing, follow-up terminal input, release of the input stream before a run can request approval, and Tavily setup help;
- [`test/mcp.test.ts`](./test/mcp.test.ts) starts local stdio and HTTP fixtures to verify MCP initialization, session handling, tool discovery, namespaced exposure, and tool-result continuation without a network dependency;
- [`test/action-runtime.test.ts`](./test/action-runtime.test.ts) exercises patch preflight, workspace confinement, symlink rejection, local search, Tavily requests, command timeouts, environment filtering, and workspace configuration restrictions;
- [`test/tavily-web-search.test.ts`](./test/tavily-web-search.test.ts) verifies Tavily request construction, source normalization, missing credentials, and safe HTTP-failure handling without a live API call;
- [`test/command-sandbox.test.ts`](./test/command-sandbox.test.ts) exercises the real macOS Seatbelt adapter and deterministically simulates delayed unified-log publication;
- [`test/openai-provider.test.ts`](./test/openai-provider.test.ts) uses a local fake HTTP server to verify Responses API translation, configurable server-side compaction, and bounded client-side continuation without a real API call;
- [`test/recorder.test.ts`](./test/recorder.test.ts) verifies append-only recording of provider-neutral context-compaction metadata;
- [`test/conversation-history.test.ts`](./test/conversation-history.test.ts) verifies per-Workspace persistence, owner-only writes, corrupt-file tolerance, and clearing;
- [`test/credentials.test.ts`](./test/credentials.test.ts) verifies credential precedence, prompting, migration, validation, and file permissions.
- [`test/updater.test.ts`](./test/updater.test.ts) verifies installation eligibility, throttling, semantic-version policy, non-blocking failures, and private update state.

The normal local validation sequence is:

```sh
pnpm typecheck
pnpm test
pnpm build
```

`pnpm smoke:openai` is an opt-in external integration check and requires real credentials.

## Development evaluation harness

The repository-local evaluation harness under [`evals/`](./evals/) and [`scripts/eval.ts`](./scripts/eval.ts) is development infrastructure and is not included in the published package.

## Evolution rules

Keep this file descriptive rather than aspirational. When implementation changes any of the following, update the corresponding section here in the same change:

- module responsibilities or dependencies;
- startup, run, action, cancellation, or completion flow;
- action schemas, workspace constraints, approval policy, or command execution;
- configuration precedence or authority boundaries;
- credential, instruction, or provider-state handling;
- persisted paths, external integrations, or validation strategy.

Pure implementation changes that do not alter these architectural facts do not need a ceremonial edit.

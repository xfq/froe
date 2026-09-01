# froe

Froe is an inspectable coding agent for work in a codebase. Here, *inspectable* means a person can reconstruct a run after the fact: which actions it requested, their effects or results, the approval decisions that applied, and why it completed, stopped, or failed. The control flow that governs those decisions is explicit in the code, and Froe core emits structured run events and records. It does not mean retaining source contents or unrestricted model text by default.

The npm package exposes two public interfaces:

- **Froe CLI** is the terminal application.
- **Froe core** is the embeddable library imported from `@xfq/froe/core`. It owns sessions, runs, actions, safety policy, configuration, integrations, and records without depending on terminal input or output.

A froe is a hand tool that splits wood along its grain; this agent borrows that idea for code changes: investigate the local structure, make a precise patch, and leave evidence behind.

In the project mark, the forward wedge is the tool's cutting edge, and the diagonal stroke is the cut following the grain.

## Froe CLI quick start

Requires Node.js 22+. Command execution currently requires macOS; on other operating systems, file actions still work but `run_command` fails closed. Install Froe CLI globally with npm:

```sh
npm install --global @xfq/froe
froe --help
```

Global npm installations check for a newer stable release at most once every 24 hours and install it before continuing. The current invocation is already loaded, so it finishes with its starting version and the next invocation uses the update. Source checkouts, `npx` runs, linked packages, and other installation methods are never modified automatically. An update failure is reported but does not block the requested coding task; use `--no-update` to skip the check once.

To try froe without installing it globally, use:

```sh
npx @xfq/froe --help
```

You can also use the installer, which checks that Node.js 22+ is available and then installs the npm package:

```sh
curl -fsSL https://raw.githubusercontent.com/xfq/froe/main/scripts/install.sh | sh
```

Then run it from the repository you want it to work in:

```sh
cd /path/to/your-project
froe "Fix the failing parser tests"
```

Run Froe CLI without a task to keep working in the same terminal conversation. Each message starts a bounded run with the current model context and Workspace; blank messages are ignored, and `/exit` leaves the conversation. Press Tab after `/` to complete the available slash commands:

```text
$ froe
froe conversation · gpt-5.6-terra
workspace: /path/to/your-project
Send a follow-up after each run, or type /exit to leave.
you: Fix the failing parser tests
...
you: Also add a regression test for the empty input case
...
you: /model gpt-5.6-sol
froe conversation · gpt-5.6-sol
you: Re-run the failing test
...
you: /exit
```

The conversation's model context is stored per Workspace and resumes the next time you start `froe` in that directory, so you can close the terminal and continue later. Type `/new` to clear the stored context and start a fresh conversation. One-shot invocations with a task argument do not load or update the stored conversation.

Use `/model <model-id>` to select the OpenAI-compatible model for later messages in the current conversation. It does not change configuration files or the default for the next invocation, and it retains the in-memory conversation context.

Use `"/init"` to ask Froe to inspect the workspace and create a starter `AGENTS.md`. It preserves an existing root instruction file:

```sh
froe "/init"
```

On the first interactive run, froe asks for an API key with hidden input and an OpenAI-compatible base URL. Press Enter at the Base URL prompt to use `https://api.openai.com/v1`. Froe saves both values in `$XDG_CONFIG_HOME/froe/credentials.json`, or `~/.config/froe/credentials.json` by default. The credential file is readable only by its owner, and later runs reuse the connection automatically.

For an OpenAI-compatible endpoint, set `OPENAI_BASE_URL` alongside the provider's API key:

```sh
cd /path/to/your-project
export OPENAI_API_KEY="..."
export OPENAI_BASE_URL="https://api.example.com/v1"
froe --model "provider-model-id" "Fix the failing parser tests"
```

To let Froe look up current external documentation or information, save a Tavily API key once from an interactive terminal. Froe stores it in the same owner-only credential file as the OpenAI connection, runs web searches automatically, and never passes the key to commands it runs:

```sh
froe --configure-tavily
froe "Check the current framework docs and update this project"
```

Pass a task as arguments or pipe it through stdin. Use `--workspace` only when the target differs from the current directory:

```sh
froe "Add validation for empty usernames"
git diff | froe "Review this diff and fix the most important defect"
froe --workspace ../my-project "Add validation for empty usernames"
froe --workspace ../my-project --add-dir ../shared --add-dir ../generated "Update the generated client"
```

## Configuration

Every session uses Froe core's shared configuration system, including sessions opened by Froe CLI. From highest to lowest precedence, it merges invocation overrides, an explicit configuration file, Workspace configuration, user configuration, and defaults. When using Froe CLI, `--config` selects the explicit file and configuration-related flags supply the invocation overrides; embedders pass `configPath` and `overrides` to `openFroeSession`.

- User configuration: `$XDG_CONFIG_HOME/froe/config.json`, or `~/.config/froe/config.json`
- Workspace configuration: `.froe/config.json`
- Schema: [froe.config.schema.json](./froe.config.schema.json)

Example user configuration:

```json
{
  "$schema": "./froe.config.schema.json",
  "baseURL": "https://api.example.com/v1",
  "autoUpdate": true,
  "model": "gpt-5.6-terra",
  "reasoning": "medium",
  "compactThresholdTokens": 200000,
  "maxTurns": 40,
  "logging": "metadata",
  "limits": {
    "commandTimeoutMs": 120000
  },
  "commandEnv": ["DATABASE_URL"],
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    },
    "remote-docs": {
      "url": "https://example.com/mcp"
    }
  }
}
```

For an OpenAI-compatible provider, set `OPENAI_API_KEY` to that provider's key and set its endpoint with `OPENAI_BASE_URL`, `baseURL` in user configuration, or `--base-url`; the latter options take precedence. For example:

```sh
OPENAI_API_KEY="..." OPENAI_BASE_URL="https://api.example.com/v1" \
  froe --model "provider-model-id" "Inspect this repository"
```

The provider must support the OpenAI Responses API, including function calling. OpenAI server-side context compaction starts at 200,000 tokens by default. Set `compactThresholdTokens` to a positive integer in user configuration to change the threshold, or to `null` for a compatible endpoint that does not support `context_management`. Set `autoUpdate` to `false` in user configuration to disable automatic updates. Workspace configuration may set only `model` and `limits`; it cannot select an API endpoint, configure MCP, control compaction or updates, pass environment variables, or weaken approvals. Setting `OPENAI_API_KEY` bypasses the saved connection; pair it with `OPENAI_BASE_URL` for a compatible endpoint, or froe uses the default OpenAI base URL. `--base-url` and user configuration override either Base URL. Credentials are never read from workspace configuration or `.env` files. See the [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction).

## MCP servers

MCP servers extend the model with tools and context. Add a local stdio server with a server label followed by the command it should run:

```sh
froe mcp add context7 -- npx -y @upstash/context7-mcp
```

Add a remote MCP endpoint with its Streamable HTTP URL:

```sh
froe mcp add my-server --url https://example.com/mcp
```

Either command writes the server definition under `mcpServers` in user configuration. On every run, froe starts local servers or connects to remote endpoints, discovers their tools, and exposes them to the model with names such as `mcp__context7__resolve-library-id`. Remote connections use Streamable HTTP, including JSON and server-sent event responses and MCP session IDs. A server that cannot connect successfully is reported and omitted; it does not prevent the rest of the run. In a conversation, use `/mcp` to view only active servers.

Run `froe --configure-tavily` once from an interactive terminal to save a `TAVILY_API_KEY` in Froe's private credential file and enable the `web_search` action. Setting `TAVILY_API_KEY` in the environment temporarily overrides the saved key. Tavily search uses its documented Search API with bounded source excerpts. See the [Tavily Search API reference](https://docs.tavily.com/api-reference/endpoint/search).

## Safety model

froe can read and search the Workspace, apply exact text patches, and run ordinary commands automatically. If a Tavily key has been configured, it can also request a web search automatically. Use repeatable `--add-dir <path>` flags to grant the run read/write access to named directories outside the Workspace; local file actions use absolute paths for those directories. On macOS, every spawned command runs under a generated Seatbelt profile that can read only the Workspace, declared additional directories, its temporary directory, required system runtime locations, and the resolved Node toolchain; it can write only to the Workspace, declared additional directories, and temporary directory, and cannot access the network. The child receives the temporary directory as its home directory, so it cannot discover user credentials through `HOME`. Froe itself, its run record, approval prompt, credentials, OpenAI connection, and Tavily connection stay outside that child-process sandbox.

An MCP server is explicitly selected in user configuration, so it is outside the local action sandbox and approval boundary. Add only servers and remote URLs you trust: their tools and responses become model context, and a remote server receives each MCP request. Froe starts local servers without a shell and gives each one a fresh temporary home, cache, and minimal environment.

froe only edits UTF-8 text files inside the Workspace or directories explicitly passed through `--add-dir`. It rejects symbolic links, undeclared paths, binary data, mode changes, and renames. Existing Git changes are allowed; froe never commits, resets, or rolls them back.

## Observability and data

Each CLI invocation writes a JSONL record to `$XDG_STATE_HOME/froe/runs` or `~/.local/state/froe/runs` unless `--no-log` is used. An interactive conversation records each of its bounded runs in the same file. Metadata records let a person reconstruct the run's action sequence, safe action summaries, result status, approval reasons, and final outcome with verification. They omit source content, patch bodies, tool output, and model text by default; set `logging` to `full` only for local debugging.

Automatic update checks store only their last-check timestamp in `$XDG_STATE_HOME/froe/update.json`, or `~/.local/state/froe/update.json` by default.

Interactive conversations keep one resumable continuation per Workspace in `$XDG_STATE_HOME/froe/conversations/<workspace-hash>.json`, or `~/.local/state/froe/conversations/<workspace-hash>.json` by default. The file is owner-only and outside the Workspace, and it stores the same continuation items the model already saw: assistant text, tool calls and their source-bearing results, and compaction checkpoints. Attached image bytes are stripped. Froe loads it when an interactive session starts and saves it after each completed run; `/new` deletes it and resets the in-memory context. A missing, unreadable, or foreign history file starts a fresh conversation, and a failed save never changes a completed run's reported outcome.

The OpenAI adapter sends `store: false` and retains the current session's continuation state in memory. When server-side compaction returns a checkpoint, froe discards the older in-memory continuation and records a safe `context_compacted` event containing only item counts and the configured threshold. The opaque checkpoint is never copied into the run record. See [OpenAI's data controls documentation](https://developers.openai.com/api/docs/guides/your-data#default-usage-policies-by-endpoint) for the distinction between response storage and API abuse-monitoring retention.

## Froe core

Froe core is the adapter-independent agent runtime, not a wrapper around the CLI. `@xfq/froe/core` is its supported public interface for building another presentation adapter. `openFroeSession` loads the same configuration and credentials used by Froe CLI, creates the provider, recorder, approval gate, sandbox, action runtime, project instructions, Tavily adapter, and MCP connections, and returns one session for a fixed Workspace.

Install the package as an application dependency, then import its core subpath:

```sh
npm install @xfq/froe
```

```ts
import { openFroeSession } from "@xfq/froe/core";

const session = await openFroeSession({
  workspace: "/path/to/project",
  adapter: {
    onEvent: ({ event }) => render(event),
    requestApproval: (prompt, signal) => askUser(prompt, signal),
  },
});

try {
  const outcome = await session.run({ task: "Fix the failing parser tests" });
  console.log(outcome.status);
} finally {
  await session.close();
}
```

The adapter receives versioned, ordered event envelopes and may collect only the approval decisions offered by Froe core. If no approval adapter is present, approval-required actions fail closed. `session.status()` returns serializable Workspace, effective configuration, record path, MCP status, and active-run state. A session accepts only one run at a time, preserves provider continuation across sequential runs, and cancels its active run before closing.

Graphical and other presentation adapters should use the exported `summarizeAction` and `redactSensitiveText` helpers when displaying action details or approval reasons. The summaries omit source and search contents and redact common credential-shaped values. Their output is plain text, not sanitized HTML.

Use `configureFroe` for shared non-run operations such as inspecting connection status, saving OpenAI or Tavily credentials, and adding a user-controlled MCP server. Do not import `dist/run.js`, `dist/action-runtime.js`, or other implementation files; they are intentionally outside the package export map.

## Development

To contribute to froe itself, clone the repository and use pnpm:

```sh
git clone https://github.com/xfq/froe.git
cd froe
pnpm install
```

```sh
pnpm typecheck
pnpm test
pnpm build
```

The project website is a dependency-free static site under `site/`. Preview it
locally from the repository root:

```sh
python3 -m http.server 8000 --directory site
```

The suite uses a deterministic model adapter and a local fake OpenAI server; it makes no external network calls or billable API requests. On macOS it also runs local Seatbelt integration tests, including a connection attempt to a closed localhost port. `pnpm smoke:openai` is opt-in and does make a minimal API request.

The repository also includes an agent-neutral coding evaluation under [`evals/`](./evals/). It replays real historical tasks in isolated one-commit workspaces and records automated plus manual-review scores. See [`evals/README.md`](./evals/README.md) for the construction rules and runner commands.

`pnpm exec tsx src/cli.ts "..."` is for developing froe itself. Without `--workspace`, it uses this repository as the Workspace. To exercise the development entry point against another repository, pass its path explicitly:

```sh
pnpm exec tsx src/cli.ts --workspace /path/to/your-project "Fix the failing parser tests"
```

To keep a released package and the local development version available at the same time, reserve `froe` for the globally installed release and add a `froe-dev` shell function for this checkout. Add the following to `~/.zshrc`, replacing the path with your clone's location:

```sh
froe-dev() {
  local workspace=$PWD
  (cd /path/to/froe && pnpm exec tsx src/cli.ts --workspace "$workspace" "$@")
}
```

Then, from a target repository, use `froe "..."` for the released version and `froe-dev "..."` for the local source version. Use `froe --version` or `froe-dev --version` to confirm the package version in use. Avoid `npm link`, which replaces the release command with the local checkout and makes the two easy to confuse.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the current design and source map, and update it alongside architecture-affecting implementation changes.

## License

[Apache-2.0](./LICENSE).

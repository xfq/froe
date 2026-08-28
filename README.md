# froe

froe is an inspectable coding agent for work in a codebase. Here, *inspectable* means a person can reconstruct a run after the fact: which actions it requested, their effects or results, the approval decisions that applied, and why it completed, stopped, or failed. The control flow that governs those decisions is explicit in the code, and the CLI emits structured run events and records. It does not mean retaining source contents or unrestricted model text by default.

A froe is a hand tool that splits wood along its grain; this agent borrows that idea for code changes: investigate the local structure, make a precise patch, and leave evidence behind.

In the project mark, the forward wedge is the tool's cutting edge, and the diagonal stroke is the cut following the grain.

In the first release:

- One-shot tasks and interactive conversations
- OpenAI Responses API through the official SDK
- Automatic updates for npm-managed global installations
- Local tools for listing, reading, searching, patching, and validating code
- Automatic macOS Seatbelt containment for spawned commands
- Explicit approval for destructive actions and narrow sandbox exceptions
- Structured run records outside the target workspace

## Quick start

Requires Node.js 22+. Command execution currently requires macOS; on other operating systems, file actions still work but `run_command` fails closed. Install froe globally with npm:

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

Run `froe` without a task in an interactive terminal to keep working in the same conversation. Each message starts a bounded run with the same model context and Workspace; blank messages are ignored, and `/exit` leaves the conversation. Press Tab after `/` to complete the available slash commands (`/exit` and `/init`):

```text
$ froe
froe conversation · gpt-5.6-terra
workspace: /path/to/your-project
Send a follow-up after each run, or type /exit to leave.
you: Fix the failing parser tests
...
you: Also add a regression test for the empty input case
...
you: /exit
```

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

Pass a task as arguments or pipe it through stdin. Use `--workspace` only when the target differs from the current directory:

```sh
froe "Add validation for empty usernames"
git diff | froe "Review this diff and fix the most important defect"
froe --workspace ../my-project "Add validation for empty usernames"
froe --workspace ../my-project --add-dir ../shared --add-dir ../generated "Update the generated client"
```

## Configuration

froe merges settings in this order: CLI flags, a path explicitly passed with `--config`, Workspace configuration, user configuration, then defaults.

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
  "commandEnv": ["DATABASE_URL"]
}
```

For an OpenAI-compatible provider, set `OPENAI_API_KEY` to that provider's key and set its endpoint with `OPENAI_BASE_URL`, `baseURL` in user configuration, or `--base-url`; the latter options take precedence. For example:

```sh
OPENAI_API_KEY="..." OPENAI_BASE_URL="https://api.example.com/v1" \
  froe --model "provider-model-id" "Inspect this repository"
```

The provider must support the OpenAI Responses API, including function calling. OpenAI server-side context compaction starts at 200,000 tokens by default. Set `compactThresholdTokens` to a positive integer in user configuration to change the threshold, or to `null` for a compatible endpoint that does not support `context_management`. Set `autoUpdate` to `false` in user configuration to disable automatic updates. Workspace configuration may set only `model` and `limits`; it cannot select an API endpoint, control compaction or updates, pass environment variables, or weaken approvals. Setting `OPENAI_API_KEY` bypasses the saved connection; pair it with `OPENAI_BASE_URL` for a compatible endpoint, or froe uses the default OpenAI base URL. `--base-url` and user configuration override either Base URL. Credentials are never read from workspace configuration or `.env` files. See the [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction).

## Safety model

froe can read and search the Workspace, apply exact text patches, and run ordinary commands automatically. Use repeatable `--add-dir <path>` flags to grant the run read/write access to named directories outside the Workspace; local file actions use absolute paths for those directories. On macOS, every spawned command runs under a generated Seatbelt profile that can read only the Workspace, declared additional directories, its temporary directory, required system runtime locations, and the resolved Node toolchain; it can write only to the Workspace, declared additional directories, and temporary directory, and cannot access the network. The child receives the temporary directory as its home directory, so it cannot discover user credentials through `HOME`. Froe itself, its run record, approval prompt, credentials, and OpenAI connection stay outside that child-process sandbox.

froe only edits UTF-8 text files inside the Workspace or directories explicitly passed through `--add-dir`. It rejects symbolic links, undeclared paths, binary data, mode changes, and renames. Existing Git changes are allowed; froe never commits, resets, or rolls them back.

## Observability and data

Each CLI invocation writes a JSONL record to `$XDG_STATE_HOME/froe/runs` or `~/.local/state/froe/runs` unless `--no-log` is used. An interactive conversation records each of its bounded runs in the same file. Metadata records let a person reconstruct the run's action sequence, safe action summaries, result status, approval reasons, and final outcome with verification. They omit source content, patch bodies, tool output, and model text by default; set `logging` to `full` only for local debugging.

Automatic update checks store only their last-check timestamp in `$XDG_STATE_HOME/froe/update.json`, or `~/.local/state/froe/update.json` by default.

The OpenAI adapter sends `store: false` and retains the current CLI conversation's continuation state in memory. When server-side compaction returns a checkpoint, froe discards the older in-memory continuation and records a safe `context_compacted` event containing only item counts and the configured threshold. The opaque checkpoint is never copied into the run record. Conversations cannot be resumed after the process exits. See [OpenAI's data controls documentation](https://developers.openai.com/api/docs/guides/your-data#default-usage-policies-by-endpoint) for the distinction between response storage and API abuse-monitoring retention.

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

# froe

froe is an inspectable coding agent for work in a codebase. A froe is a hand tool that splits wood along its grain; this agent borrows that idea for code changes: investigate the local structure, make a precise patch, and leave evidence behind.

In the first release:

- One-shot tasks and interactive conversations
- OpenAI Responses API through the official SDK
- Local tools for listing, reading, searching, patching, and validating code
- Automatic macOS Seatbelt containment for spawned commands
- Explicit approval for destructive actions and narrow sandbox exceptions
- Structured run records outside the target workspace

## Quick start

Requires Node.js 22+ and pnpm. Command execution currently requires macOS; on other operating systems, file actions still work but `run_command` fails closed. Install dependencies, build froe, and register its command globally:

```sh
pnpm install
pnpm build

pnpm add --global .
froe --help
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
  "model": "gpt-5.6-terra",
  "reasoning": "medium",
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

The provider must support the OpenAI Responses API, including function calling. Workspace configuration may set only `model` and `limits`; it cannot select an API endpoint, pass environment variables, or weaken approvals. Setting `OPENAI_API_KEY` bypasses the saved connection; pair it with `OPENAI_BASE_URL` for a compatible endpoint, or froe uses the default OpenAI base URL. `--base-url` and user configuration override either Base URL. Credentials are never read from workspace configuration or `.env` files.

## Safety model

froe can read and search the Workspace, apply exact text patches, and run ordinary commands automatically. On macOS, every spawned command runs under a generated Seatbelt profile that permits writes only to the Workspace and the process temporary directory and denies network access. Froe itself, its run record, approval prompt, credentials, and OpenAI connection stay outside that child-process sandbox.

froe only edits UTF-8 text files inside the Workspace. It rejects symbolic links, files outside the Workspace, binary data, mode changes, and renames. Existing Git changes are allowed; froe never commits, resets, or rolls them back.

## Observability and data

Each CLI invocation writes a JSONL record to `$XDG_STATE_HOME/froe/runs` or `~/.local/state/froe/runs` unless `--no-log` is used. An interactive conversation records each of its bounded runs in the same file. Metadata records include action names, paths, command arguments, exit statuses, approvals, and outcomes. They omit source content, patch bodies, tool output, and model text by default; set `logging` to `full` only for local debugging.

The OpenAI adapter sends `store: false` and retains the current CLI conversation's continuation state in memory. Conversations cannot be resumed after the process exits. See [OpenAI's data controls documentation](https://developers.openai.com/api/docs/guides/your-data#default-usage-policies-by-endpoint) for the distinction between response storage and API abuse-monitoring retention.

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
```

The suite uses a deterministic model adapter and a local fake OpenAI server; it makes no external network calls or billable API requests. On macOS it also runs local Seatbelt integration tests, including a connection attempt to a closed localhost port. `pnpm smoke:openai` is opt-in and does make a minimal API request.

`pnpm dev -- "..."` is for developing froe itself. Without `--workspace`, it uses this repository as the Workspace. To exercise the development entry point against another repository, pass its path explicitly:

```sh
pnpm dev -- --workspace /path/to/your-project "Fix the failing parser tests"
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the current design and source map, and update it alongside architecture-affecting implementation changes.

## License

[Apache-2.0](./LICENSE).

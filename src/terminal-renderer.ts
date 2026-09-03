import { formatActionDetails, redactSensitiveText } from "./action-summary.js";
import type { ConversationTurn } from "./conversation.js";
import type { RunEvent } from "./types.js";

export interface TerminalRendererOptions {
  output: NodeJS.WritableStream;
  verbose: boolean;
  recordPath: string | undefined;
  conversationMode: boolean;
}

export interface TerminalRenderer {
  startConversationTurn(turn: ConversationTurn): void;
  render(event: RunEvent): void;
}

/**
 * Renders each interactive run beneath a numbered user-message heading so a
 * scrolled terminal transcript retains the relationship between a task and
 * every piece of its response.
 */
export function createTerminalRenderer(options: TerminalRendererOptions): TerminalRenderer {
  let activeTurn: ConversationTurn | undefined;
  let progressActive = false;
  let progressFrame = 0;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  const prefix = (): string => activeTurn === undefined ? "" : `[${activeTurn.number}] `;
  const isTerminal = (options.output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY === true;
  const writeLines = (linePrefix: string, text: string): void => {
    for (const line of text.split(/\r?\n/)) options.output.write(`${linePrefix}${line}\n`);
  };
  const writeActionDetails = (action: { name: string; arguments: unknown }): void => {
    for (const detail of formatActionDetails(action)) writeLines(`${prefix()}  `, detail);
  };
  const startProgress = (): void => {
    if (progressActive) return;
    progressActive = true;
    if (!isTerminal) {
      options.output.write(`${prefix()}\n`);
      return;
    }
    writeProgressFrame();
    progressTimer = setInterval(() => {
      progressFrame = (progressFrame + 1) % progressFrames.length;
      writeProgressFrame();
    }, 120);
    progressTimer.unref();
  };
  const stopProgress = (): void => {
    if (!progressActive) return;
    progressActive = false;
    if (progressTimer !== undefined) {
      clearInterval(progressTimer);
      progressTimer = undefined;
    }
    if (isTerminal) options.output.write("\r\u001B[2K");
  };
  const writeProgressFrame = (): void => {
    options.output.write(`\r${prefix()}${progressFrames[progressFrame]} `);
  };

  return {
    startConversationTurn(turn): void {
      activeTurn = turn;
      options.output.write(`\n[${turn.number}] you: ${summarizeMessage(turn.message)}\n[${turn.number}] froe:\n`);
      startProgress();
    },
    render(event): void {
      if (event.type !== "run_started") stopProgress();
      switch (event.type) {
        case "run_started":
          if (options.conversationMode) startProgress();
          else {
            options.output.write(`froe · ${event.model}\nworkspace: ${event.workspace}\n`);
            if (options.recordPath !== undefined) options.output.write(`record: ${options.recordPath}\n`);
          }
          break;
        case "model_text":
          if (event.text.trim()) writeLines(`${prefix()}froe: `, event.text.trim());
          break;
        case "action_requested":
          options.output.write(`${prefix()}→ ${event.action.name}\n`);
          writeActionDetails(event.action);
          break;
        case "approval_requested":
          writeLines(prefix(), `! approval needed: ${redactSensitiveText(event.reason)}`);
          writeActionDetails(event.action);
          break;
        case "action_result":
          writeLines(prefix(), `${event.result.ok ? "✓" : "✗"} ${event.result.name}${resultSuffix(event.result)}`);
          if (options.verbose) writeLines(prefix(), JSON.stringify(event.result.output, null, 2));
          break;
        case "context_compacted":
          options.output.write(`${prefix()}↻ context compacted (${event.previousItems} → ${event.retainedItems} items)\n`);
          break;
        case "usage":
          if (options.verbose) options.output.write(`${prefix()}usage: ${event.inputTokens} input, ${event.outputTokens} output tokens\n`);
          break;
        case "run_finished":
          writeLines(prefix(), `${event.outcome.status}: ${event.outcome.summary}`);
          for (const check of event.outcome.verification) writeLines(`${prefix()}  `, `${check.result}: ${check.description}`);
          break;
      }
    },
  };
}

const progressFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function summarizeMessage(message: string): string {
  const line = message.replaceAll(/\s+/g, " ").trim();
  return line.length <= 120 ? line : `${line.slice(0, 117)}…`;
}

function resultSuffix(result: { name: string; ok: boolean; output: unknown }): string {
  if (!result.ok && isRecord(result.output) && typeof result.output.message === "string") return ` — ${result.output.message}`;
  if (result.name === "run_command" && isRecord(result.output) && typeof result.output.exitCode === "number") return ` (exit ${result.output.exitCode})`;
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

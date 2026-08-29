import { createInterface } from "node:readline/promises";
import type { ConversationMessage } from "./conversation.js";

const slashCommands = ["/exit", "/init", "/model"];

export type TerminalMessage = ConversationMessage;

export async function* terminalMessages(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  signal: AbortSignal,
): AsyncGenerator<TerminalMessage> {
  while (!signal.aborted) {
    const readline = createInterface({ input, output, completer: completeSlashCommand });
    let message: string;
    try {
      message = (await readline.question("you: ", { signal })).trim();
    } catch (error) {
      if (signal.aborted || isReadlineClosed(error)) return;
      throw error;
    } finally {
      readline.close();
    }
    if (message === "/exit") return;
    if (message === "/model") {
      output.write("Usage: /model <model-id>\n");
      continue;
    }
    if (message.startsWith("/model ")) {
      const model = message.slice("/model ".length).trim();
      if (model) yield { type: "model", model };
      else output.write("Usage: /model <model-id>\n");
      continue;
    }
    if (message) yield { type: "task", text: message };
  }
}

export function completeSlashCommand(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  return [slashCommands.filter((command) => command.startsWith(line)), line];
}

function isReadlineClosed(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ERR_USE_AFTER_CLOSE";
}

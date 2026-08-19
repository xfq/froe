import { createInterface } from "node:readline/promises";

const slashCommands = ["/exit", "/init"];

export async function* terminalMessages(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  signal: AbortSignal,
): AsyncGenerator<string> {
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
    if (message) yield message;
  }
}

export function completeSlashCommand(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  return [slashCommands.filter((command) => command.startsWith(line)), line];
}

function isReadlineClosed(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ERR_USE_AFTER_CLOSE";
}

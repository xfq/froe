import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ConversationMessage } from "./conversation.js";

const slashCommands = ["/exit", "/init", "/mcp", "/model", "/new"];

export type TerminalMessage = ConversationMessage;

export async function* terminalMessages(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  signal: AbortSignal,
): AsyncGenerator<TerminalMessage> {
  while (!signal.aborted) {
    const text = await readMessage(input, output, signal);
    if (text === undefined) return;
    const message = text.trim();
    if (message === "/exit") return;
    if (message === "/mcp") {
      yield { type: "mcp" };
      continue;
    }
    if (message === "/new") {
      yield { type: "reset" };
      continue;
    }
    if (message === "/model") {
      output.write("Usage: /model <model-id>\n");
      continue;
    }
    if (!message.includes("\n") && message.startsWith("/model ")) {
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

/** Keep paste delimiters and their contents out of readline's Enter handling. */
async function readMessage(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (signal.aborted) return undefined;
  const terminalInput = input as NodeJS.ReadableStream & { isRaw?: boolean; setRawMode?(mode: boolean): unknown };
  const isTerminal = (output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY === true;
  const wasRaw = terminalInput.isRaw ?? false;
  const keyboard = new PassThrough();
  const readline = createInterface({
    input: keyboard,
    ...(isTerminal ? { output } : {}),
    terminal: true,
    completer: completeSlashCommand,
  });
  const decoder = new StringDecoder("utf8");
  const lines: string[] = [];
  let pending = "";
  let paste: string | undefined;
  let submissionRequested = false;
  let resolveMessage: (text: string | undefined) => void;
  let rejectMessage: (error: Error) => void;
  const result = new Promise<string | undefined>((resolve, reject) => {
    resolveMessage = resolve;
    rejectMessage = reject;
  });
  const submit = (): void => {
    if (paste !== undefined || !submissionRequested) return;
    // readline may have consumed several lines and a trailing partial line in
    // the same input chunk. Preserve them all before releasing stdin.
    resolveMessage([...lines, ...(readline.line ? [readline.line] : [])].join("\n"));
  };
  const onData = (chunk: Buffer | string): void => {
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (pending) {
      const marker = paste === undefined ? "\u001b[200~" : "\u001b[201~";
      const index = pending.indexOf(marker);
      let length = index;
      if (index === -1) {
        let retained = Math.min(pending.length, marker.length - 1);
        while (retained > 0 && !marker.startsWith(pending.slice(-retained))) retained -= 1;
        length = pending.length - retained;
      }
      const text = pending.slice(0, length);
      if (paste === undefined) keyboard.write(text);
      else paste += text;
      pending = pending.slice(length);
      if (index === -1) break;
      pending = pending.slice(marker.length);
      if (paste === undefined) paste = "";
      else {
        const text = paste.replace(/\r\n?/g, "\n");
        const suffix = readline.line.slice(readline.cursor);
        readline.write(null, { ctrl: true, name: "k" });
        // write() inserts paste contents literally, without treating tabs or
        // escape characters as editing keys. Completed lines stay buffered.
        readline.write(text);
        readline.write(suffix);
        for (const _character of suffix) readline.write(null, { name: "left" });
        paste = undefined;
      }
    }
    queueMicrotask(submit);
  };
  const onAbort = (): void => resolveMessage(undefined);
  const onError = (error: Error): void => rejectMessage(error);
  const onEnd = (): void => {
    // An interrupted paste is not a submitted task.
    if (paste !== undefined) resolveMessage(undefined);
    else {
      keyboard.write(pending + decoder.end());
      resolveMessage([...lines, readline.line].join("\n") || undefined);
    }
  };
  readline.on("line", (line: string) => {
    lines.push(line);
    if (paste === undefined) submissionRequested = true;
  });
  readline.on("close", onAbort);
  signal.addEventListener("abort", onAbort, { once: true });
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("error", onError);
  try {
    terminalInput.setRawMode?.(true);
    if (isTerminal) {
      output.write("\u001b[?2004h");
      readline.setPrompt("you: ");
      readline.prompt();
    } else output.write("you: ");
    input.resume();
    return await result;
  } finally {
    input.pause();
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("error", onError);
    signal.removeEventListener("abort", onAbort);
    readline.close();
    keyboard.destroy();
    terminalInput.setRawMode?.(wasRaw);
    if (isTerminal) output.write("\u001b[?2004l");
  }
}

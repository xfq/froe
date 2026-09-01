import type { FroeSession, FroeSessionStatus } from "./session.js";
import type { RunOutcome } from "./types.js";

export type ConversationMessage =
  | { type: "task"; text: string }
  | { type: "model"; model: string }
  | { type: "reset" }
  | { type: "mcp" };

export interface ConversationRequest {
  session: FroeSession;
  messages: AsyncIterable<ConversationMessage>;
  imagePaths?: readonly string[];
  signal?: AbortSignal;
  onModelSelected?(model: string): void | Promise<void>;
  onResetConversation?(): void | Promise<void>;
  showMcpServers?(status: FroeSessionStatus): void | Promise<void>;
}

export async function runConversation(request: ConversationRequest): Promise<RunOutcome[]> {
  const outcomes: RunOutcome[] = [];
  let imagePaths = request.imagePaths;
  let model = request.session.status().config.model;

  for await (const message of request.messages) {
    if (message.type === "model") {
      model = message.model;
      await request.onModelSelected?.(model);
      continue;
    }
    if (message.type === "mcp") {
      await request.showMcpServers?.(request.session.status());
      continue;
    }
    if (message.type === "reset") {
      await request.onResetConversation?.();
      continue;
    }

    const outcome = await request.session.run({
      task: message.text,
      ...(imagePaths === undefined || imagePaths.length === 0 ? {} : { imagePaths }),
      model,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    imagePaths = undefined;
    outcomes.push(outcome);
    if (outcome.status === "cancelled") break;
  }

  return outcomes;
}

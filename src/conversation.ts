import { runTask, type RunRequest } from "./run.js";
import type { RunOutcome } from "./types.js";

export type ConversationMessage =
  | { type: "task"; text: string }
  | { type: "model"; model: string };

export interface ConversationRequest extends Omit<RunRequest, "task"> {
  messages: AsyncIterable<ConversationMessage>;
  selectModel(model: string): void | Promise<void>;
}

export async function runConversation(request: ConversationRequest): Promise<RunOutcome[]> {
  const outcomes: RunOutcome[] = [];
  let images = request.images;
  let modelName = request.modelName;

  for await (const message of request.messages) {
    if (message.type === "model") {
      await request.selectModel(message.model);
      modelName = message.model;
      continue;
    }

    const outcome = await runTask({
      task: message.text,
      ...(images === undefined || images.length === 0 ? {} : { images }),
      model: request.model,
      runtime: request.runtime,
      instructions: request.instructions,
      modelName,
      maxTurns: request.maxTurns,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.emit === undefined ? {} : { emit: request.emit }),
    });
    images = undefined;
    outcomes.push(outcome);
    if (outcome.status === "cancelled") break;
  }

  return outcomes;
}

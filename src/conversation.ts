import { runTask, type RunRequest } from "./run.js";
import type { RunOutcome } from "./types.js";

export interface ConversationRequest extends Omit<RunRequest, "task"> {
  messages: AsyncIterable<string>;
}

export async function runConversation(request: ConversationRequest): Promise<RunOutcome[]> {
  const outcomes: RunOutcome[] = [];

  for await (const message of request.messages) {
    const task = message.trim();
    if (!task) continue;

    const outcome = await runTask({
      task,
      model: request.model,
      runtime: request.runtime,
      instructions: request.instructions,
      modelName: request.modelName,
      maxTurns: request.maxTurns,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.emit === undefined ? {} : { emit: request.emit }),
    });
    outcomes.push(outcome);
    if (outcome.status === "cancelled") break;
  }

  return outcomes;
}

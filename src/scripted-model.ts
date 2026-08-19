import type { ActionResult, ModelEvent, ModelProvider, ModelTurn } from "./types.js";

export interface ScriptedTurn extends ModelTurn {
  actionResults?: ActionResult[];
}

export type Script = ModelEvent[] | ((turn: ScriptedTurn, index: number) => ModelEvent[] | Promise<ModelEvent[]>);

export class ScriptedModel implements ModelProvider {
  readonly name = "scripted";
  readonly #scripts: Script[];
  #index = 0;
  #actionResults: ActionResult[] | undefined;

  constructor(scripts: Script[]) {
    this.#scripts = scripts;
  }

  recordActionResults(results: ActionResult[]): void {
    this.#actionResults = [...(this.#actionResults ?? []), ...results];
  }

  async *turn(input: ModelTurn): AsyncIterable<ModelEvent> {
    const script = this.#scripts[this.#index];
    const index = this.#index;
    this.#index += 1;
    const turn: ScriptedTurn = {
      ...input,
      ...(this.#actionResults === undefined ? {} : { actionResults: this.#actionResults }),
    };
    this.#actionResults = undefined;
    if (script === undefined) {
      yield { type: "completed" };
      return;
    }
    const events = typeof script === "function" ? await script(turn, index) : script;
    for (const event of events) yield event;
    if (!events.some((event) => event.type === "completed")) yield { type: "completed" };
  }
}

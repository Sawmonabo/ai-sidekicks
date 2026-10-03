// The handle a driver in another process holds on the running scenario: the Electron tiers advance
// the frozen clock through it and read how far the script has got.

import type { ScenarioEngine } from "./engine.fixture.js";

/** What a driver may do with the running scenario. Closed, and read-mostly. */
export interface ScenarioFixtureHandle {
  /** The scenario actually playing: the selection's outcome, not its request. */
  readonly scenarioId: string;
  /** Advance the frozen clock, delivering every beat that falls due. */
  advance(milliseconds: number): void;
  /** How many beats have been delivered so far. */
  deliveredBeatCount(): number;
}

/**
 * The engine, narrowed to what a driver in another process needs: what is playing, move it, and
 * how far it got. Not the engine itself, since a driver that could dispose it could end a run by
 * tearing down what it is measuring.
 */
export class ScenarioFixtureControl implements ScenarioFixtureHandle {
  readonly #engine: ScenarioEngine;

  public constructor(engine: ScenarioEngine) {
    this.#engine = engine;
  }

  public get scenarioId(): string {
    return this.#engine.scenario.id;
  }

  public advance(milliseconds: number): void {
    this.#engine.advance(milliseconds);
  }

  public deliveredBeatCount(): number {
    return this.#engine.progress.deliveredBeatCount;
  }
}

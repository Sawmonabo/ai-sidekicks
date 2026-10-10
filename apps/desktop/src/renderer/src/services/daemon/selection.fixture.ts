// The handle a driver in another process holds on the running scenario: the Electron tiers advance
// the frozen clock through it, run the frames it has armed, and read how far the script has got.
//
// The frozen clock runs no frame by itself, since no window paces it, so a driver plays one real
// frame as `advance` and then `runFrame`, inside that frame's `requestAnimationFrame` callback.

import type { ScenarioEngine } from "./engine.fixture.js";

/** What a driver may do with the running scenario. Closed, and read-mostly. */
export interface ScenarioFixtureHandle {
  /** The scenario actually playing: the selection's outcome, not its request. */
  readonly scenarioId: string;
  /** Advance the frozen clock, delivering every beat that falls due. Runs no frame. */
  advance(milliseconds: number): void;
  /** Run the frame callbacks armed on the frozen clock, once. Moves no time. */
  runFrame(): void;
  /** How many frame callbacks are armed on the frozen clock and not yet run. */
  pendingFrameCount(): number;
  /** How many beats have been delivered so far. */
  deliveredBeatCount(): number;
}

/**
 * The engine, narrowed to what a driver in another process needs: what is playing, move it and
 * its frames, and how far it got. Not the engine itself, since a driver that could dispose it
 * could end a run by tearing down what it is measuring.
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

  public runFrame(): void {
    this.#engine.runFrame();
  }

  public pendingFrameCount(): number {
    return this.#engine.pendingFrameCount;
  }

  public deliveredBeatCount(): number {
    return this.#engine.progress.deliveredBeatCount;
  }
}

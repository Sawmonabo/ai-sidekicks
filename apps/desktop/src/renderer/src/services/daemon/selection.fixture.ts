// The handle a driver in another process holds on the running scenario: the Electron
// tiers advance the frozen clock through it and read how far the script has got.

import { SCENARIO_FIXTURE_GLOBAL } from "@renderer/console/core/fixture-globals.js";
import type { ScenarioEngine } from "./engine.fixture.js";

/** What a driver may do with the running scenario. Closed, and read-mostly. */
export interface ScenarioFixtureHandle {
  /** The scenario actually playing — the selection's outcome, not its request. */
  readonly scenarioId: string;
  /** Advance the frozen clock, delivering every beat that falls due. */
  advance(milliseconds: number): void;
  /** How many beats have been delivered so far. */
  deliveredBeatCount(): number;
}

/**
 * The engine, narrowed to what a driver in another process needs.
 *
 * A wrapper rather than exposing `ScenarioEngine` itself, because the engine can
 * also be DISPOSED and subscribed to, and a driver that could dispose the engine
 * could end a run by tearing down the thing it is measuring. Three members is the
 * whole surface: what is playing, move it, and how far it got.
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

  /**
   * Hang this control on a page. Returns the teardown that removes it.
   *
   * The teardown removes the property only when it still holds THIS control. The
   * browser tiers mount several consoles into one document, so a later provider's
   * install supersedes an earlier one — and an unconditional `delete` on the
   * earlier one's unmount would strip the handle a live window had just installed.
   */
  public install(target: Record<string, unknown>): () => void {
    target[SCENARIO_FIXTURE_GLOBAL] = this;
    return () => {
      if (target[SCENARIO_FIXTURE_GLOBAL] === this) {
        delete target[SCENARIO_FIXTURE_GLOBAL];
      }
    };
  }
}

// The fixture scenario's seam with everything outside this renderer.
//
// Two directions, one module, because they are two halves of a single fact —
// WHICH scripted session this window is playing:
//
//   • IN — the scenario id a launched fixture build was started with, carried on
//     the document URL's query string and read exactly ONCE, at boot.
//   • OUT — a handle on the running engine, hung on the page under one name, so a
//     driver in another process can advance the frozen clock and read how far the
//     script has got.
//
// WHY A QUERY PARAMETER AND NOT A RUNTIME SWITCH
//
// `Spec-023 §Console Design (Meridian)` §The fixture bridge makes the fixture a
// `define`-gated build-time constant. That decides WHETHER there are scenarios at
// all; it does not decide which one plays, and a build carrying six scenarios and
// no way to name one can only ever play the first. The id therefore travels on the
// document URL — a value the window is BORN with, like its opening route — and is
// read once at module evaluation rather than subscribed to. Nothing here switches
// a bridge at runtime: a second scenario means a second window, which is also the
// only shape that keeps `SidekicksBridgeProvider`'s single-resolution rule true.
//
// The main process only ever composes that query in a fixture build, so a release
// document URL carries none of it and this module is unreachable from the release
// entry point — the same guard, at the same `define`, as the bridge itself.
//
// WHY AN UNKNOWN ID IS NEITHER A THROW NOR A TRIPWIRE
//
// `consoleScenario()` throws, correctly: a surface asking for a scenario by name
// has a bug. A LAUNCH ARGUMENT is different — it is typed by a person or set by a
// CI job, and a console that refuses to boot over a misspelled fixture id is worse
// than one that boots into the first-run scenario and says so. It is not a
// tripwire either: `TRIPWIRE_KINDS` is a closed tuple naming five INVARIANT
// breaches, none of which this is, and a development registry throws on report —
// which is the outcome this paragraph just ruled out. So the miss becomes a
// `ConsoleRefusal` carried on the selection, plus one diagnostic line, and the
// scenario actually playing is readable from the handle below — which is what the
// endurance tier asserts, so a typo fails a tier rather than passing quietly.

import { SCENARIO_FIXTURE_GLOBAL, refuse, type ConsoleRefusal } from "../../core/index.js";
import { CONSOLE_SCENARIOS } from "./scenario-manifest.js";
import type { ScenarioEngine } from "./scenario-engine.js";
import { FIRST_RUN_SCENARIO_ID } from "../scenarios/first-run.js";

/** The document-URL query parameter a fixture build carries its scenario id on. */
export const SCENARIO_QUERY_PARAMETER = "scenario";

/** The subsystem name every refusal this module raises carries. */
export const SCENARIO_SELECTION_REFUSAL_ORIGIN = "scenario-selection";

/** Why a requested scenario was not played. Closed — one miss is the only case. */
export const SCENARIO_SELECTION_REFUSAL_CODE = "scenario-unknown";

/**
 * Which scenario this window plays, decided from the document URL it opened at.
 *
 * A class rather than a function because the decision has three parts a caller
 * reads separately — what plays, what was asked for, and whether the two differ —
 * and because the instance is a SNAPSHOT: it is constructed from a search string
 * and never consults the location again, so a later navigation cannot move a
 * scenario out from under a running engine.
 */
export class ScenarioSelection {
  readonly #scenarioId: string;
  readonly #requestedScenarioId: string | undefined;
  readonly #refusal: ConsoleRefusal | undefined;

  /**
   * Decide from a document search string (`location.search`, or `""`).
   *
   * Takes the string rather than reading the location itself, so the decision is
   * a pure function of its input and the one site that touches a global is the
   * static below.
   */
  public constructor(documentSearch: string) {
    const requested = new URLSearchParams(documentSearch).get(SCENARIO_QUERY_PARAMETER);
    if (requested === null || requested === "") {
      this.#requestedScenarioId = undefined;
      this.#scenarioId = FIRST_RUN_SCENARIO_ID;
      this.#refusal = undefined;
      return;
    }
    this.#requestedScenarioId = requested;
    if (CONSOLE_SCENARIOS.some((scenario) => scenario.id === requested)) {
      this.#scenarioId = requested;
      this.#refusal = undefined;
      return;
    }
    this.#scenarioId = FIRST_RUN_SCENARIO_ID;
    // The refused id is deliberately absent from `detail`, which `core/refusal.ts`
    // reserves for a sentence that never carries the refused value. The known ids
    // are what a reader acts on anyway.
    this.#refusal = refuse(
      SCENARIO_SELECTION_REFUSAL_ORIGIN,
      SCENARIO_SELECTION_REFUSAL_CODE,
      `no scenario on the fixture manifest carries the requested id, so the console is playing "${FIRST_RUN_SCENARIO_ID}" instead. Known ids: ${CONSOLE_SCENARIOS.map((scenario) => scenario.id).join(", ")}.`,
    );
  }

  /** The scenario that will actually play. Always a manifest id. */
  public get scenarioId(): string {
    return this.#scenarioId;
  }

  /** What the document URL asked for, or `undefined` when it asked for nothing. */
  public get requestedScenarioId(): string | undefined {
    return this.#requestedScenarioId;
  }

  /** Why the request was not honoured, or `undefined` when it was. */
  public get refusal(): ConsoleRefusal | undefined {
    return this.#refusal;
  }

  /**
   * Read the decision off this document, once.
   *
   * The ONE site in the console that reads `location` for a scenario, and it is
   * called from exactly one place — the renderer root's `define`-gated boot
   * constant — so a release build, where that guard folds to `false`, never
   * reaches it and never reads the query.
   *
   * The diagnostic is written here rather than in the constructor because this is
   * the boot path: constructing a selection in a test should not print, and a
   * launch that was given an id nobody serves should.
   */
  public static fromDocumentLocation(): ScenarioSelection {
    const selection = new ScenarioSelection(globalThis.location.search);
    const refusal = selection.refusal;
    if (refusal !== undefined) {
      console.warn(
        `${refusal.origin}: ${refusal.code}: requested "${String(selection.requestedScenarioId)}" — ${refusal.detail}`,
      );
    }
    return selection;
  }
}

/*
 * The property a fixture build hangs the scenario control on, for the two
 * Electron tiers.
 *
 * Declared in `core/fixture-globals.ts` and re-exported here, so this installer
 * and the release-absence sweep that proves the handle absent read one string.
 * Re-exported rather than only imported because the driving tiers reach this
 * module by name for it, and a retyped literal at either end would leave a tier
 * reading `undefined` and reporting a missing property instead of a rename.
 */
export { SCENARIO_FIXTURE_GLOBAL };

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

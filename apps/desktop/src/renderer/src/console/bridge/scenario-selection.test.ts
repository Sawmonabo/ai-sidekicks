// Which scenario a launched fixture build plays, and the handle that drives it.
//
// Both halves are read from OUTSIDE this process — the id arrives on a document
// URL the main process composed, the handle is called from a Playwright driver —
// so every case below pins a fact one of those two ends depends on. Each has a
// negative control, because an implementation that answered the default to
// everything, or a handle that answered a constant, would satisfy the positive
// half of every one of them.

import { afterEach, describe, expect, it } from "vitest";

import {
  SCENARIO_FIXTURE_GLOBAL,
  SCENARIO_QUERY_PARAMETER,
  SCENARIO_SELECTION_REFUSAL_CODE,
  SCENARIO_SELECTION_REFUSAL_ORIGIN,
  ScenarioFixtureControl,
  ScenarioSelection,
} from "./scenario-selection.js";
import { ScenarioEngine } from "./scenario-engine.js";
import { FIRST_RUN_SCENARIO_ID } from "./scenarios/first-run.js";
import { FLAGSHIP_SCENARIO, FLAGSHIP_SCENARIO_ID } from "./scenarios/flagship.js";

const OPENING_URL = `${globalThis.location.pathname}${globalThis.location.search}`;

function setDocumentQuery(search: string): void {
  globalThis.history.replaceState(null, "", `${globalThis.location.pathname}${search}`);
}

afterEach(() => {
  globalThis.history.replaceState(null, "", OPENING_URL);
});

describe("ScenarioSelection — the id a window opened with", () => {
  it("plays the scenario the query names", () => {
    expect(
      new ScenarioSelection(`?${SCENARIO_QUERY_PARAMETER}=${FLAGSHIP_SCENARIO_ID}`).scenarioId,
    ).toBe(FLAGSHIP_SCENARIO_ID);
  });

  it("negative control: a named scenario is not silently replaced by the default", () => {
    // The whole point of the case above. A selection that always answered the
    // first-run id would pass every other assertion in this file that does not
    // name a scenario, so the inequality is asserted rather than implied.
    expect(
      new ScenarioSelection(`?${SCENARIO_QUERY_PARAMETER}=${FLAGSHIP_SCENARIO_ID}`).scenarioId,
    ).not.toBe(FIRST_RUN_SCENARIO_ID);
  });

  it("plays the first-run scenario when the query carries none", () => {
    expect(new ScenarioSelection("").scenarioId).toBe(FIRST_RUN_SCENARIO_ID);
    expect(new ScenarioSelection("").refusal).toBeUndefined();
  });

  it("ignores a query that names some other parameter", () => {
    // The parameter name is the wire between the main process and this module.
    // A reader that took the first value of any parameter would pass the case
    // above and select a scenario here.
    const selection = new ScenarioSelection(`?scenarioId=${FLAGSHIP_SCENARIO_ID}`);
    expect(selection.scenarioId).toBe(FIRST_RUN_SCENARIO_ID);
    expect(selection.requestedScenarioId).toBeUndefined();
  });

  it("falls back to the first-run scenario and refuses when the id is unknown", () => {
    const selection = new ScenarioSelection(`?${SCENARIO_QUERY_PARAMETER}=no-such-scenario`);

    expect(selection.scenarioId).toBe(FIRST_RUN_SCENARIO_ID);
    expect(selection.requestedScenarioId).toBe("no-such-scenario");
    expect(selection.refusal).toStrictEqual({
      origin: SCENARIO_SELECTION_REFUSAL_ORIGIN,
      code: SCENARIO_SELECTION_REFUSAL_CODE,
      detail: expect.stringContaining(FLAGSHIP_SCENARIO_ID) as unknown as string,
    });
  });

  it("negative control: a scenario it can play is not refused", () => {
    // Without this, a constructor that refused unconditionally would satisfy the
    // case above while making every launch play the first-run scenario.
    expect(
      new ScenarioSelection(`?${SCENARIO_QUERY_PARAMETER}=${FLAGSHIP_SCENARIO_ID}`).refusal,
    ).toBeUndefined();
  });

  it("never carries the refused id into the refusal detail", () => {
    // `core/refusal.ts` reserves `detail` for a sentence that never repeats the
    // refused value. The id still reaches a reader — through `requestedScenarioId`
    // and the boot diagnostic — but not through the field three renderers print.
    const selection = new ScenarioSelection(`?${SCENARIO_QUERY_PARAMETER}=leaked-id-marker`);
    expect(selection.refusal?.detail).not.toContain("leaked-id-marker");
  });

  it("is a snapshot: a later navigation does not move the scenario", () => {
    setDocumentQuery(`?${SCENARIO_QUERY_PARAMETER}=${FLAGSHIP_SCENARIO_ID}`);
    const selection = ScenarioSelection.fromDocumentLocation();

    setDocumentQuery(`?${SCENARIO_QUERY_PARAMETER}=${FIRST_RUN_SCENARIO_ID}`);

    // The engine is built from this value once, at mount. A getter that re-read
    // the location would hand a running window a scenario its bridge never had.
    expect(selection.scenarioId).toBe(FLAGSHIP_SCENARIO_ID);
  });

  it("reads the id off this document when it is asked to", () => {
    setDocumentQuery(`?${SCENARIO_QUERY_PARAMETER}=${FLAGSHIP_SCENARIO_ID}`);
    expect(ScenarioSelection.fromDocumentLocation().scenarioId).toBe(FLAGSHIP_SCENARIO_ID);
  });

  it("negative control: the document read answers the default with no query", () => {
    // Pins that the case above read the document rather than returning a constant.
    expect(ScenarioSelection.fromDocumentLocation().scenarioId).toBe(FIRST_RUN_SCENARIO_ID);
  });
});

describe("ScenarioFixtureControl — the handle a driver holds", () => {
  it("names the scenario its engine is playing", () => {
    const control = new ScenarioFixtureControl(new ScenarioEngine({ scenario: FLAGSHIP_SCENARIO }));
    expect(control.scenarioId).toBe(FLAGSHIP_SCENARIO_ID);
  });

  it("delivers beats as it advances, and counts them", () => {
    const engine = new ScenarioEngine({ scenario: FLAGSHIP_SCENARIO });
    const control = new ScenarioFixtureControl(engine);
    const lastBeatMs = FLAGSHIP_SCENARIO.beats.at(-1)?.atMs ?? 0;

    // Negative control for the counter: a handle answering a constant would
    // satisfy the growth assertions below without ever moving the engine.
    expect(control.deliveredBeatCount()).toBe(0);

    control.advance(1);
    const afterFirstAdvance = control.deliveredBeatCount();
    expect(afterFirstAdvance).toBeGreaterThan(0);

    control.advance(lastBeatMs);
    expect(control.deliveredBeatCount()).toBeGreaterThan(afterFirstAdvance);
    expect(control.deliveredBeatCount()).toBe(FLAGSHIP_SCENARIO.beats.length);
  });

  it("installs under one name and removes itself on teardown", () => {
    const target: Record<string, unknown> = {};
    const control = new ScenarioFixtureControl(new ScenarioEngine({ scenario: FLAGSHIP_SCENARIO }));

    // Constructing installs nothing: the property appears at `install` and only
    // there, which is what keeps the one call site inside the fixture guard.
    expect(target[SCENARIO_FIXTURE_GLOBAL]).toBeUndefined();

    const remove = control.install(target);
    expect(target[SCENARIO_FIXTURE_GLOBAL]).toBe(control);

    remove();
    expect(target[SCENARIO_FIXTURE_GLOBAL]).toBeUndefined();
  });

  it("a superseded control's teardown leaves the live one installed", () => {
    // Several consoles mount into one document in the browser tiers. An
    // unconditional delete on the first one's unmount would strip the handle the
    // second had just installed, and the tier reading it would see nothing.
    const target: Record<string, unknown> = {};
    const first = new ScenarioFixtureControl(new ScenarioEngine({ scenario: FLAGSHIP_SCENARIO }));
    const second = new ScenarioFixtureControl(new ScenarioEngine({ scenario: FLAGSHIP_SCENARIO }));

    const removeFirst = first.install(target);
    second.install(target);
    removeFirst();

    expect(target[SCENARIO_FIXTURE_GLOBAL]).toBe(second);
  });
});

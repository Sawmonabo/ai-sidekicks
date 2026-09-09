// The mounted pane re-reads because the SESSION said the run moved, and the clock that
// releases that re-read is the fixture's frozen one.
//
// WHAT THIS COVERS THAT `run-live-rounds.test.ts` CANNOT. That suite drives
// `WorkflowRunLiveRounds` directly on a bare `ManualClock` and counts its round, which
// is the right instrument for WHICH kinds advance it. It says nothing about whether the
// mounted pane is wired to one at all: the round could climb while the pane asked the
// daemon nothing, and every case there would still be green. So this suite mounts the
// pane, puts a frame on the session behind it, and reads the answer off the DOM and off
// the port the pane actually called.
//
// THE CLOCK IS WHY THE HELPER EXISTS. The round is released by the console's one
// `RefreshScheduler`, which arms its debounce on the clock the pane resolved from its
// bridge — under the fixture, the scenario's frozen one. Real time moves it not at all,
// so the advance runs through `bridge/scenario/runtime/clock.test-support.ts`,
// which sits beside the engine that owns that clock precisely so a second view family
// could reach it without importing a sibling family's fixture.
//
// THE SESSION IS FED BY THE SCENARIO, not hand-written into the store. The pane's whole
// claim is about frames arriving from outside this window, so the beats that arrive are
// the ones the running scenario plays — which is also what makes the negative control a
// real advance rather than an empty one.
//
// NOBODY PRESSES ANYTHING, and that is checked rather than said. The other half of the
// pane's round is an operator's own act coming back served, so both mutating operations
// are wrapped and counted, and both cases assert zero. That other half has a suite of
// its own in `WorkflowRunPane.form-rearm.test.tsx`, which drives the same moving-run
// bridge from the shared harness and moves the run by answering the park instead.

import { afterEach, describe, expect, it } from "vitest";

import { type ConsoleBridge } from "../../../bridge/index.js";
import {
  advanceScenarioOneInterval,
  advanceScenarioUntil,
} from "../../../bridge/scenario/runtime/clock.test-support.js";
import { WORKFLOWS_PARKED_RUN } from "../../../bridge/scenario/workflows/runs.js";
import { WORKFLOWS_SCENARIO } from "../../../bridge/scenario/workflows/workflows.js";
import { REFRESH_DEBOUNCE_MS, REFRESH_MAX_WAIT_MS } from "../../../core/index.js";
import type { SessionStore } from "../../../store/index.js";
import { eventOfKind } from "../../../store/session-event.test-support.js";
import {
  PARKED,
  RUN_WITH_HUMAN_PARK_ANSWERED,
  bridgeWhoseRunMoves,
  initialisedSessionStore,
  paneContext,
  parkedPhaseCountOf,
  renderPane,
} from "./WorkflowRunPane.test-support.js";

/** One park card. Counted rather than read, because what moves is how many stand. */
const PARK_SELECTOR = ".meridian-park";

/** How many of the fixture run's phases are parked when the pane first reads it. */
const PARKED_PHASE_COUNT = parkedPhaseCountOf(WORKFLOWS_PARKED_RUN);

/** How many stand once the human park has been answered. One fewer, same derivation. */
const ANSWERED_PARK_COUNT = parkedPhaseCountOf(RUN_WITH_HUMAN_PARK_ANSWERED);

/**
 * Enough intervals to spend the coalescing scheduler's whole maximum wait.
 *
 * The negative control needs a bound rather than a condition: there is no state to wait
 * for, and the claim is that none arrives. `REFRESH_MAX_WAIT_MS` is the longest a
 * `RefreshScheduler` can hold a requested read, so a clock driven past it with the read
 * count unmoved is a scheduler that was never asked — which is the claim — rather than
 * one still holding the answer.
 */
const PASSES_PAST_MAX_WAIT = Math.ceil(REFRESH_MAX_WAIT_MS / REFRESH_DEBOUNCE_MS) + 1;

/** Every scenario subscription a case opened, detached whatever the case did. */
const detachers: (() => void)[] = [];

afterEach(() => {
  for (const detach of detachers.splice(0)) {
    detach();
  }
});

/**
 * The pane's session, fed the running scenario's own beats as the clock delivers them.
 *
 * This is the shell's wiring in miniature: `SessionStoreRegistry` opens one
 * `session.subscribe` per open session and projects its frames into a `SessionStore`,
 * and under the fixture that subscription is the scenario engine. Subscribing the store
 * here is what makes an advance of the frozen clock a real arrival on the session's
 * timeline rather than a hand-written frame — and it is why the negative control below
 * can say that the advance carried traffic and still bought no read.
 */
function sessionFedByScenario(bridge: ConsoleBridge): SessionStore {
  const scenarioEngine = bridge.scenarioEngine;
  if (scenarioEngine === undefined) {
    throw new Error("this bridge runs no scenario, so no beat can reach the pane's session");
  }
  const sessionStore = initialisedSessionStore();
  detachers.push(
    scenarioEngine.subscribe((events) => {
      sessionStore.applyBatch(events);
    }),
  );
  return sessionStore;
}

/** The sequence after everything this store has admitted. */
function nextSequence(sessionStore: SessionStore): number {
  return sessionStore.snapshot().cursor + 1;
}

describe("workflow run pane — the run moves under the answer on screen", () => {
  it("re-reads and shows the moved run when the session carries a workflow frame", async () => {
    const { bridge, runReadCount, controlCallCount, reportRunAdvanced } = bridgeWhoseRunMoves();
    const sessionStore = sessionFedByScenario(bridge);
    const section = renderPane(paneContext(PARKED, bridge, sessionStore));

    // Driven until the scenario has played out AND the first read has landed, so the
    // frame below lands after the scenario's own six beats rather than in front of one
    // — a sequence ahead of an undelivered beat is a gap, and a store repaired from a
    // gap re-reads for the reconnect reason, which is not the reason under test.
    await advanceScenarioUntil(bridge, () => {
      expect(sessionStore.snapshot().cursor).toBe(WORKFLOWS_SCENARIO.beats.length);
      expect(section.querySelectorAll(PARK_SELECTOR)).toHaveLength(PARKED_PHASE_COUNT);
    });
    expect(runReadCount()).toBe(1);

    // The engine answered the sign-off phase, so the daemon now holds a run with one
    // park fewer — and the only thing telling this pane to ask again is the frame.
    reportRunAdvanced();
    sessionStore.applyBatch([
      eventOfKind(sessionStore.sessionId, "workflow.phase_resumed", nextSequence(sessionStore)),
    ]);
    await advanceScenarioUntil(bridge, () => {
      expect(section.querySelectorAll(PARK_SELECTOR)).toHaveLength(ANSWERED_PARK_COUNT);
    });

    // A re-read and not a re-render: the count is what tells those two apart, and the
    // card that went is what says the second answer reached the screen.
    expect(runReadCount()).toBe(2);
    expect(ANSWERED_PARK_COUNT).toBeLessThan(PARKED_PHASE_COUNT);
    // Nobody at this keyboard did anything. Both mutating wires are counted, so this
    // is the claim checked rather than the claim assumed.
    expect(controlCallCount()).toBe(0);
  });

  it("negative control: a scenario advance carrying no workflow frame puts no second read", async () => {
    // Without this the case above would pass over a pane that re-read on any session
    // transition at all — a read cadence keyed to session traffic rather than to the
    // run having moved, which is the polling `Spec-023`'s refresh policy forbids.
    const { bridge, runReadCount, controlCallCount, reportRunAdvanced } = bridgeWhoseRunMoves();
    const sessionStore = sessionFedByScenario(bridge);
    const section = renderPane(paneContext(PARKED, bridge, sessionStore));

    // THE CURSOR IS WHAT KEEPS THIS CASE FROM BEING VACUOUS. It only reaches the beat
    // count once every one of the scenario's own beats has arrived — the session's
    // creation, its two agent attachments, and the three run-lifecycle transitions of
    // the ordinary agent run one running phase dispatched — so the clock advance below
    // is measured against a store that took six transitions, none of them in the
    // workflow taxonomy, rather than against a session where nothing happened at all.
    await advanceScenarioUntil(bridge, () => {
      expect(sessionStore.snapshot().cursor).toBe(WORKFLOWS_SCENARIO.beats.length);
      expect(section.querySelectorAll(PARK_SELECTOR)).toHaveLength(PARKED_PHASE_COUNT);
    });

    // And one more transition of a kind this scenario already plays, applied exactly
    // the way the case above applies its workflow frame, so the two differ in the KIND
    // and in nothing else. The moved answer is armed too, so a pane that did re-read
    // would be caught by the DOM as well as by the count.
    reportRunAdvanced();
    sessionStore.applyBatch([
      eventOfKind(sessionStore.sessionId, "run.running", nextSequence(sessionStore)),
    ]);
    for (let pass = 0; pass < PASSES_PAST_MAX_WAIT; pass += 1) {
      await advanceScenarioOneInterval(bridge);
    }

    expect(runReadCount()).toBe(1);
    expect(section.querySelectorAll(PARK_SELECTOR)).toHaveLength(PARKED_PHASE_COUNT);
    expect(controlCallCount()).toBe(0);
  });
});

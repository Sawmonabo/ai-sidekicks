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
// so the advance runs through `bridge/scenario-runtime/scenario-clock.test-support.ts`,
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
// are wrapped and counted, and both cases assert zero.

import { afterEach, describe, expect, it } from "vitest";

import {
  createFixtureBridge,
  type ConsoleBridge,
  type GrowthPort,
  type WorkflowPhaseState,
  type WorkflowRunSnapshot,
} from "../../../bridge/index.js";
import {
  advanceScenarioOneInterval,
  advanceScenarioUntil,
} from "../../../bridge/scenario-runtime/scenario-clock.test-support.js";
import { WORKFLOWS_PARKED_RUN } from "../../../bridge/scenarios/workflow-fixture-runs.js";
import { WORKFLOWS_SCENARIO } from "../../../bridge/scenarios/workflows.js";
import { REFRESH_DEBOUNCE_MS, REFRESH_MAX_WAIT_MS } from "../../../core/index.js";
import type { SessionStore } from "../../../store/index.js";
import { eventOfKind } from "../../../store/session-event.test-support.js";
import {
  PARKED,
  initialisedSessionStore,
  paneContext,
  renderPane,
} from "./WorkflowRunPane.test-support.js";

/** One park card. Counted rather than read, because what moves is how many stand. */
const PARK_SELECTOR = ".meridian-park";

/** How many of the fixture run's phases are parked when the pane first reads it. */
const PARKED_PHASE_COUNT = parkedPhaseCountOf(WORKFLOWS_PARKED_RUN);

/**
 * The same run once the sign-off phase's human park has been answered.
 *
 * DERIVED FROM THE FIXTURE RATHER THAN WRITTEN OUT, so a scenario that re-keys its
 * phases moves this with it and the two cannot describe different runs. The park
 * members are live-scoped — a daemon emits them for exactly the phases parked when the
 * response was built — so a phase that has completed carries none of them and carries
 * no open form revision either, which is what makes one fewer card the honest reading
 * of this answer rather than a card being hidden.
 */
const RUN_WITH_HUMAN_PARK_ANSWERED: WorkflowRunSnapshot = {
  ...WORKFLOWS_PARKED_RUN,
  phaseStates: WORKFLOWS_PARKED_RUN.phaseStates.map((phase) =>
    phase.parkReason === "waiting-human" ? completedPhase(phase) : phase,
  ),
};

/** And how many stand once it has. One fewer, off the same derivation. */
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

/** How many phases of one run carry the park discriminator. */
function parkedPhaseCountOf(run: WorkflowRunSnapshot): number {
  return run.phaseStates.filter((phase) => phase.parkReason !== undefined).length;
}

/**
 * One phase, completed and therefore carrying no park and no open form.
 *
 * The identity members are carried through where the fixture states them and omitted
 * where it does not, rather than passed as an explicit `undefined`: the wire's own rule
 * is that their PRESENCE is the claim, and a completed phase is still the same
 * execution instance it was while it ran.
 */
function completedPhase(phase: WorkflowPhaseState): WorkflowPhaseState {
  return {
    phaseId: phase.phaseId,
    ...(phase.phaseRunId === undefined ? {} : { phaseRunId: phase.phaseRunId }),
    ...(phase.attemptNumber === undefined ? {} : { attemptNumber: phase.attemptNumber }),
    state: "completed",
    gateState: "open",
  };
}

/** A fixture bridge whose run read can move, with both instruments on it. */
interface MovingRunBridge {
  readonly bridge: ConsoleBridge;
  /** How many times the daemon was asked for this run. The re-read instrument. */
  readonly runReadCount: () => number;
  /** How many times an operator control reached the wire. Zero in every case here. */
  readonly controlCallCount: () => number;
  /** The engine moved the run, so the next answer carries one park fewer. */
  readonly reportRunAdvanced: () => void;
}

/**
 * The workflows fixture, with the run read answering a run that can move.
 *
 * THE FIXTURE'S OWN PORT UNDERNEATH, with three operations wrapped and the rest passed
 * through: the version chain the pane resolves from the served snapshot, the phase
 * outputs, and every refusal the mutating wires give are the fixture's answers still, so
 * this bridge differs from the one every other run-pane suite mounts in exactly the axis
 * these cases vary.
 *
 * WHY THE READ IS SCRIPTED AT ALL. The fixture answers `workflow.runRead` from a fixed
 * table, so a re-read of it returns the same bytes and a pane that re-read would look
 * identical to one that did not. A daemon whose run has moved answers differently, and
 * that is the whole subject here — so the moved answer is armed by the case at the same
 * moment the case says the run moved.
 */
function bridgeWhoseRunMoves(): MovingRunBridge {
  const fixture = createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });
  let runReads = 0;
  let controlCalls = 0;
  let hasAdvanced = false;
  const growth: GrowthPort = {
    ...fixture.growth,
    workflowRunRead: async () => {
      runReads += 1;
      return {
        status: "served",
        value: hasAdvanced ? RUN_WITH_HUMAN_PARK_ANSWERED : WORKFLOWS_PARKED_RUN,
      };
    },
    workflowRunCancel: async (request) => {
      controlCalls += 1;
      return fixture.growth.workflowRunCancel(request);
    },
    workflowRunResume: async (request) => {
      controlCalls += 1;
      return fixture.growth.workflowRunResume(request);
    },
  };
  return {
    bridge: { ...fixture, growth },
    runReadCount: () => runReads,
    controlCallCount: () => controlCalls,
    reportRunAdvanced: () => {
      hasAdvanced = true;
    },
  };
}

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

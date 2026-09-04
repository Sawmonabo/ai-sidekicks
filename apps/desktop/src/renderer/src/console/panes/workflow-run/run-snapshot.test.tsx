// The run read has four endings, and the pane has to be able to tell them apart.
//
// Every case drives a REAL growth port — the fixture's over a scenario that scripts
// what the case is about, or the refusing one — rather than a promise shaped like one.
// A stand-in port would agree with whatever the hook did with it.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type GrowthPort } from "../../bridge/index.js";
import { createRefusingGrowthPort } from "../../bridge/growth-port.js";
import type { ConsoleScenario, ScenarioReply } from "../../bridge/scenario.js";
import {
  WORKFLOWS_PARKED_RUN,
  WORKFLOWS_SCENARIO_RUNS,
} from "../../bridge/scenarios/workflow-fixture-runs.js";
import type { WireErrorEnvelope } from "../../../../../shared/wire-errors.js";
import {
  latestCommitted,
  observeStampedRead,
} from "../../store/subject-stamped-state.test-support.js";
import { useWorkflowRunSnapshot, type WorkflowRunSnapshotState } from "./run-snapshot.js";

const PROBE_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3401";
const PROBE_PARTICIPANT_ID = "019b7a12-0280-79a4-8110-cca0117a0401";

/** The refusal the scenarios below script, in the envelope a daemon sends. */
const SCRIPTED_DAEMON_REFUSAL: WireErrorEnvelope = {
  code: "workflow.run_not_found",
  message: "That run is not on this node.",
};

/**
 * A scenario scripting exactly what one case needs for the run read, and no beats.
 *
 * Beats would have to be held to the wire-truth layer for facts no case here asserts,
 * and this hook never reads the event stream at all.
 */
function scenarioAnsweringTheRunRead(replies: readonly ScenarioReply[]): ConsoleScenario {
  return {
    id: "run-snapshot-probe",
    label: "Run snapshot probe",
    purpose: "Answers the run read one way, so one settlement at a time is observable.",
    sessionId: PROBE_SESSION_ID,
    participantIdsInJoinOrder: [PROBE_PARTICIPANT_ID],
    startedAtIso: "2026-01-01T12:00:00.000Z",
    beats: [],
    replies,
  };
}

function SnapshotProbe(props: {
  readonly growth: GrowthPort;
  readonly workflowRunId: string | undefined;
  readonly onObserve: (state: WorkflowRunSnapshotState) => void;
}): React.JSX.Element {
  props.onObserve(useWorkflowRunSnapshot(props.growth, props.workflowRunId));
  return <></>;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function observeSnapshot(
  growth: GrowthPort,
  workflowRunId: string | undefined,
): WorkflowRunSnapshotState[] {
  return retargetableSnapshot(growth, workflowRunId).observed;
}

/**
 * The same probe, with the handle a retarget needs.
 *
 * A pane is not remounted when the deck points it at another run — it is re-rendered
 * with a different address, which is the whole subject of the retarget case below.
 */
function retargetableSnapshot(
  growth: GrowthPort,
  workflowRunId: string | undefined,
): {
  readonly observed: WorkflowRunSnapshotState[];
  readonly retarget: (next: string) => void;
} {
  const observed: WorkflowRunSnapshotState[] = [];
  const collect = (state: WorkflowRunSnapshotState): void => {
    observed.push(state);
  };
  const view = render(
    <SnapshotProbe growth={growth} workflowRunId={workflowRunId} onObserve={collect} />,
  );
  return {
    observed,
    retarget: (next) => {
      view.rerender(<SnapshotProbe growth={growth} workflowRunId={next} onObserve={collect} />);
    },
  };
}

/** The real port answering the run read from the fixture's own runs, by id. */
function runReadingGrowthPort(): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    workflowRunRead: async ({ workflowRunId }) => {
      const run = WORKFLOWS_SCENARIO_RUNS.find(
        (candidate) => candidate.workflowRunId === workflowRunId,
      );
      if (run === undefined) {
        throw new Error(`no fixture run with id ${workflowRunId}`);
      }
      return { status: "served", value: run };
    },
  };
}

function firstState(observed: readonly WorkflowRunSnapshotState[]): WorkflowRunSnapshotState {
  const state = observed[0];
  if (state === undefined) {
    throw new Error("the probe never rendered, so there is no state to read");
  }
  return state;
}

function lastState(observed: readonly WorkflowRunSnapshotState[]): WorkflowRunSnapshotState {
  const state = observed.at(-1);
  if (state === undefined) {
    throw new Error("the probe never rendered, so there is no state to read");
  }
  return state;
}

describe("useWorkflowRunSnapshot — one read, four answers", () => {
  afterEach(() => {
    cleanup();
  });

  it("puts no question at all where the pane names no run", () => {
    // `unasked` on the FIRST render as well as the last, so the arm that must stay
    // unasked is held to the same moment as the arm below that must not be.
    const observed = observeSnapshot(createRefusingGrowthPort(), undefined);
    expect(firstState(observed).status).toBe("unasked");
    expect(lastState(observed).status).toBe("unasked");
  });

  it("is already reading on the first render an addressed pane commits", () => {
    // The state was initialised `unasked` and only became `reading` in the effect,
    // which runs after the commit — so an addressed pane painted one frame reading
    // "This run has not been read in this window" over a read it had already issued.
    const observed = observeSnapshot(runReadingGrowthPort(), WORKFLOWS_PARKED_RUN.workflowRunId);
    expect(firstState(observed).status).toBe("reading");
  });

  it("shows the previous run's phases nowhere once the pane is retargeted", async () => {
    const [firstRun, secondRun] = WORKFLOWS_SCENARIO_RUNS;
    if (firstRun === undefined || secondRun === undefined) {
      throw new Error("the workflows fixture carries fewer than two runs");
    }
    const probe = retargetableSnapshot(runReadingGrowthPort(), firstRun.workflowRunId);
    await settle();
    expect(lastState(probe.observed).status).toBe("served");

    act(() => {
      probe.retarget(secondRun.workflowRunId);
    });

    // Reading, not run A's snapshot: before the stamp, A's phases and A's park cards
    // stayed renderable under B's address until the effect got round to resetting.
    expect(lastState(probe.observed).status).toBe("reading");

    await settle();
    const settled = lastState(probe.observed);
    expect(settled.status).toBe("served");
    if (settled.status === "served") {
      expect(settled.snapshot.workflowRunId).toBe(secondRun.workflowRunId);
    }
  });

  it("starts as a read in flight and settles on the scripted snapshot", async () => {
    // The control for the refusal cases below: a hook that refused every read would
    // satisfy them and would replace every served snapshot with a refusal too.
    const growth = createFixtureBridge({
      scenario: scenarioAnsweringTheRunRead([
        { call: "workflow.runRead", result: WORKFLOWS_PARKED_RUN },
      ]),
    }).growth;

    const observed = observeSnapshot(growth, WORKFLOWS_PARKED_RUN.workflowRunId);
    // The state after the mount and before the answer. Every render of it, first
    // included, because the read is stamped with the run it is about.
    expect(lastState(observed).status).toBe("reading");

    await settle();
    const settled = lastState(observed);
    expect(settled.status).toBe("served");
    if (settled.status === "served") {
      expect(settled.snapshot.workflowRunId).toBe(WORKFLOWS_PARKED_RUN.workflowRunId);
    }
  });

  it("settles a scripted daemon refusal as unavailable, carrying the wire's own code", async () => {
    // The negative control is the assertion itself: over the `.then`-only hook this
    // read replaced, the rejection was unhandled and the last state observed here was
    // `reading` — permanently, with operator controls beside a spinner that never ends.
    const growth = createFixtureBridge({
      scenario: scenarioAnsweringTheRunRead([
        { call: "workflow.runRead", refusal: SCRIPTED_DAEMON_REFUSAL },
      ]),
    }).growth;

    const observed = observeSnapshot(growth, WORKFLOWS_PARKED_RUN.workflowRunId);

    await settle();
    const settled = lastState(observed);
    expect(settled.status).toBe("unavailable");
    if (settled.status === "unavailable") {
      expect(settled.refusal.code).toBe(SCRIPTED_DAEMON_REFUSAL.code);
      expect(settled.refusal.detail).toBe(SCRIPTED_DAEMON_REFUSAL.message);
    }
    // Never an empty run: that would assert the run has no phases, a claim about the
    // daemon that nothing established.
    expect(observed.map((state) => state.status)).not.toContain("served");
  });

  it("carries the port's own refusal when no wire is registered", async () => {
    const observed = observeSnapshot(
      createRefusingGrowthPort(),
      WORKFLOWS_PARKED_RUN.workflowRunId,
    );

    await settle();
    const settled = lastState(observed);
    expect(settled.status).toBe("unavailable");
    if (settled.status === "unavailable") {
      expect(settled.refusal.code).toBe("wire-unregistered");
      expect(settled.refusal.detail).toContain("Not checked");
    }
  });
});

/**
 * The real port answering the run read with a phase count a case can trace back to the
 * bridge that served it, so a swap is observable in the snapshot and not only in the
 * status.
 */
function phaseTruncatingGrowthPort(phaseStateCount: number): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    workflowRunRead: async () => ({
      status: "served",
      value: {
        ...WORKFLOWS_PARKED_RUN,
        phaseStates: WORKFLOWS_PARKED_RUN.phaseStates.slice(0, phaseStateCount),
      },
    }),
  };
}

function servedPhaseStateCount(state: WorkflowRunSnapshotState): number | undefined {
  return state.status === "served" ? state.snapshot.phaseStates.length : undefined;
}

describe("useWorkflowRunSnapshot — the port is half of what the read is about", () => {
  afterEach(() => {
    cleanup();
  });

  it("commits no phase from the previous bridge once the port is replaced", async () => {
    // The fixture's scenario switch mints a new bridge and hands back the same run id.
    // With the stamp keyed on the run alone the state agreed with itself, so this render
    // committed the previous scenario's phases and park cards under the new one and only
    // the passive effect afterwards took them down. The cases here read what each COMMIT
    // carried, which is the only vantage that can tell the two hooks apart.
    const probe = observeStampedRead(useWorkflowRunSnapshot, {
      source: phaseTruncatingGrowthPort(2),
      subject: WORKFLOWS_PARKED_RUN.workflowRunId,
    });
    await settle();
    expect(servedPhaseStateCount(latestCommitted(probe.committed))).toBe(2);
    const commitsBeforeSwap = probe.committed.length;

    probe.readdress({
      source: phaseTruncatingGrowthPort(1),
      subject: WORKFLOWS_PARKED_RUN.workflowRunId,
    });

    expect(probe.committed.slice(commitsBeforeSwap).map((state) => state.status)).not.toContain(
      "served",
    );

    await settle();
    // The reset is only half the claim: a hook that reset and never re-read would leave
    // the pane reading forever under a bridge that can answer.
    expect(servedPhaseStateCount(latestCommitted(probe.committed))).toBe(1);
  });

  it("negative control: a re-render at the SAME port keeps the snapshot it settled on", async () => {
    // Without this, the case above passes for a hook that reset on every render, which
    // would re-read the run forever and never show a snapshot at all.
    const growth = phaseTruncatingGrowthPort(2);
    const probe = observeStampedRead(useWorkflowRunSnapshot, {
      source: growth,
      subject: WORKFLOWS_PARKED_RUN.workflowRunId,
    });
    await settle();

    probe.readdress({ source: growth, subject: WORKFLOWS_PARKED_RUN.workflowRunId });

    expect(servedPhaseStateCount(latestCommitted(probe.committed))).toBe(2);
  });
});

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
import { WORKFLOWS_PARKED_RUN } from "../../bridge/scenarios/workflow-fixture-data.js";
import type { WireErrorEnvelope } from "../../../../../shared/wire-errors.js";
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
  const observed: WorkflowRunSnapshotState[] = [];
  render(
    <SnapshotProbe
      growth={growth}
      workflowRunId={workflowRunId}
      onObserve={(state) => {
        observed.push(state);
      }}
    />,
  );
  return observed;
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
    expect(lastState(observeSnapshot(createRefusingGrowthPort(), undefined)).status).toBe(
      "unasked",
    );
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
    // The state after the mount and before the answer. The first observation is the
    // pre-effect `unasked` default, which says nothing about what the hook asked.
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

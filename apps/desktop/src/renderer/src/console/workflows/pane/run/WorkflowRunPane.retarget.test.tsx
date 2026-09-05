// The pane moved from one run to another WITHOUT UNMOUNTING, which is how the deck
// moves it.
//
// A pane's address is data the deck rewrites in place: the same component instance is
// handed run A on one render and run B on the next, so every answer the pane is holding
// has to be an answer about the run it is now addressed at. `run-snapshot.ts` states
// that rule and the read obeys it; the SELECTION beside the read did not.
//
// WHY THE TWO RUNS SHARE THEIR PHASE IDS, which is what makes this a defect rather than
// a curiosity: a phase id is the DEFINITION's, so two runs of one definition carry the
// same ids. A selection held for the mount therefore resolved cleanly against the new
// run's phases and opened a form nobody had asked for — the resolution made the stale
// id safe and said nothing about which run the person was answering about.

import { render, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFixtureBridge, type WorkflowRunSnapshot } from "../../../bridge/index.js";
import type { ConsoleScenario } from "../../../bridge/scenario.js";
import { WORKFLOWS_PARKED_RUN } from "../../../bridge/scenarios/workflow-fixture-runs.js";
import { WORKFLOWS_SCENARIO } from "../../../bridge/scenarios/workflows.js";
import type { ConsoleEntityRef } from "../../../store/index.js";
import { HumanFormSlot } from "./slots/HumanFormSlot.js";
import { WorkflowRunPane } from "./WorkflowRunPane.js";
import { paneContext } from "./WorkflowRunPane.test-support.js";

vi.mock(import("./slots/HumanFormSlot.js"), { spy: true });

/** The second branch's phase-run key on run A, in the wire's own shape. */
const SECOND_WAIT_PHASE_RUN_ID_A = "019b7a10-0280-7aa1-8100-701a11150009";

/** Run B's own keys. A phase RUN is per run even where the phase id is not. */
const RUN_B_ID = "019b7a10-0280-7f31-8100-701a1115000b";
const SECOND_WAIT_PHASE_RUN_ID_B = "019b7a10-0280-7aa1-8100-701a1115000c";

/**
 * The fixture's parked run with a SECOND phase parked on a person beside the first.
 *
 * Two waits, because the defect is only visible where the person had a CHOICE: with one
 * wait the default and the requested phase are the same phase, and a selection that
 * survived a retarget would be indistinguishable from one that was dropped.
 */
function runWithTwoHumanWaits(
  workflowRunId: string,
  secondPhaseRunId: string,
): WorkflowRunSnapshot {
  const first = WORKFLOWS_PARKED_RUN.phaseStates.find(
    (candidate) => candidate.parkReason === "waiting-human",
  );
  if (first === undefined) {
    throw new Error("the workflows fixture parks no phase on a person");
  }
  return {
    ...WORKFLOWS_PARKED_RUN,
    workflowRunId,
    phaseStates: WORKFLOWS_PARKED_RUN.phaseStates.flatMap((phase) =>
      phase.phaseId === first.phaseId
        ? [
            phase,
            { ...first, phaseId: `${first.phaseId}-second-branch`, phaseRunId: secondPhaseRunId },
          ]
        : [phase],
    ),
  };
}

const RUN_A = runWithTwoHumanWaits(WORKFLOWS_PARKED_RUN.workflowRunId, SECOND_WAIT_PHASE_RUN_ID_A);
const RUN_B = runWithTwoHumanWaits(RUN_B_ID, SECOND_WAIT_PHASE_RUN_ID_B);

function addressOf(run: WorkflowRunSnapshot): ConsoleEntityRef {
  return { kind: "workflow-run", id: run.workflowRunId };
}

/** Both runs, answered per requested id out of one table, as the fixture's own does. */
const TWO_RUN_SCENARIO: ConsoleScenario = {
  ...WORKFLOWS_SCENARIO,
  id: "workflow-run-pane-retarget",
  replies: [
    {
      call: "workflow.runRead",
      resultFor: (request) => {
        const { workflowRunId } = request as { readonly workflowRunId?: unknown };
        return [RUN_A, RUN_B].find((run) => run.workflowRunId === workflowRunId);
      },
    },
  ],
};

/** The wait whose form the pane actually mounted, on the latest render it made. */
function mountedForm(): { readonly phaseId: string; readonly workflowRunId: string } | undefined {
  return vi.mocked(HumanFormSlot).mock.calls.at(-1)?.[0].phase;
}

function humanWaitPhaseIds(run: WorkflowRunSnapshot): readonly string[] {
  return run.phaseStates
    .filter((phase) => phase.parkReason === "waiting-human")
    .map((phase) => phase.phaseId);
}

describe("a run pane retargeted at another run", () => {
  afterEach(() => {
    vi.mocked(HumanFormSlot).mockClear();
  });

  /**
   * Open run A, ask for its SECOND wait, then hand the same pane run B.
   *
   * One bridge across both, so the port's identity holds still and the run id is the
   * only thing that moves — which is the retarget the deck performs and not a remount
   * dressed up as one.
   */
  async function openSecondWaitThenRetarget(): Promise<void> {
    const bridge = createFixtureBridge({ scenario: TWO_RUN_SCENARIO });
    const { container, rerender } = render(
      <WorkflowRunPane context={paneContext(addressOf(RUN_A), bridge)} />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-park__form-action")).toHaveLength(1);
    });
    const [openTheSecond] = container.querySelectorAll(".meridian-park__form-action");
    if (openTheSecond === undefined) {
      throw new Error("the second branch's card offered no route");
    }
    fireEvent.click(openTheSecond);
    expect(mountedForm()?.phaseId).toBe(humanWaitPhaseIds(RUN_A)[1]);

    rerender(<WorkflowRunPane context={paneContext(addressOf(RUN_B), bridge)} />);
    await waitFor(() => {
      expect(mountedForm()?.workflowRunId).toBe(RUN_B_ID);
    });
  }

  it("opens the new run's default wait rather than the one asked for on the old one", async () => {
    await openSecondWaitThenRetarget();
    // The FIRST wait, which is what a pane that has been asked nothing opens. The
    // second is the one the person chose on run A, and choosing it again is theirs to
    // do — a console that carried the choice across would be answering for them about
    // a run they had not looked at yet.
    expect(mountedForm()?.phaseId).toBe(humanWaitPhaseIds(RUN_B)[0]);
    expect(mountedForm()?.phaseId).not.toBe(humanWaitPhaseIds(RUN_A)[1]);
  });

  it("negative control: the two runs really do share the phase id that was asked for", async () => {
    // The premise, asserted rather than assumed. If the ids differed, the stale
    // selection would resolve to nothing and fall back on its own, and the case above
    // would be green over a hook that holds a selection forever.
    expect(humanWaitPhaseIds(RUN_B)).toStrictEqual(humanWaitPhaseIds(RUN_A));
    expect(RUN_B.workflowRunId).not.toBe(RUN_A.workflowRunId);
  });

  it("negative control: a re-render at the SAME run keeps the wait the person chose", async () => {
    // Without this the case above would be satisfied by a hook that dropped the
    // selection on every render, which would make the second card's route unusable —
    // the operator would click it and watch the first form open again.
    const bridge = createFixtureBridge({ scenario: TWO_RUN_SCENARIO });
    const { container, rerender } = render(
      <WorkflowRunPane context={paneContext(addressOf(RUN_A), bridge)} />,
    );
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-park__form-action")).toHaveLength(1);
    });
    const [openTheSecond] = container.querySelectorAll(".meridian-park__form-action");
    if (openTheSecond === undefined) {
      throw new Error("the second branch's card offered no route");
    }
    fireEvent.click(openTheSecond);

    rerender(<WorkflowRunPane context={paneContext(addressOf(RUN_A), bridge)} />);
    expect(mountedForm()?.phaseId).toBe(humanWaitPhaseIds(RUN_A)[1]);
  });
});

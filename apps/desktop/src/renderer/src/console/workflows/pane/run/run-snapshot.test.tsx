// What the run read shows for each address: nothing asked, reading, or served, and never
// a previous run's or a previous call's answer under a new address.
//
// `run-snapshot.rounds.test.tsx` holds the address still and varies the round.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  latestCommitted,
  observeSubjectRead,
} from "../../../store/subject-read-commits.test-support.js";
import { PARKED_RUN, PROBE_RUNS, settle } from "../../workflows-probe.test-support.js";
import {
  useWorkflowRunSnapshot,
  type WorkflowRunReadCall,
  type WorkflowRunSnapshotState,
} from "./run-snapshot.js";
import { FIRST_ROUND, SnapshotProbe, runReadingCall } from "./run-snapshot.test-support.js";

/**
 * The hook at the first round, for the shared commit observer.
 *
 * The observer drives a `(source, subject)` hook, so the round is bound here rather than
 * widening a helper other suites share.
 */
function useSnapshotAtFirstRound(
  readRun: WorkflowRunReadCall,
  workflowRunId: string | undefined,
): WorkflowRunSnapshotState {
  return useWorkflowRunSnapshot(readRun, workflowRunId, FIRST_ROUND);
}

/**
 * The probe with the handle a retarget needs: a pane is re-rendered at another run
 * address, not remounted.
 */
function retargetableSnapshot(
  readRun: WorkflowRunReadCall,
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
    <SnapshotProbe readRun={readRun} workflowRunId={workflowRunId} onObserve={collect} />,
  );
  return {
    observed,
    retarget: (next) => {
      view.rerender(<SnapshotProbe readRun={readRun} workflowRunId={next} onObserve={collect} />);
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

describe("useWorkflowRunSnapshot — one read, three states", () => {
  afterEach(() => {
    cleanup();
  });

  it("puts no question at all where the pane names no run", async () => {
    const readRun = vi.fn(runReadingCall());
    const observed = retargetableSnapshot(readRun, undefined).observed;
    await settle();

    // `unasked` on the first render as well as the last, so the state that must stay
    // unasked is held to the same moment as the one below that must not be.
    expect(firstState(observed).status).toBe("unasked");
    expect(lastState(observed).status).toBe("unasked");
    expect(readRun).not.toHaveBeenCalled();
  });

  it("is already reading on the first render an addressed pane commits", () => {
    // The state is settled during the render, not in the effect after the commit, so an
    // addressed pane never paints a frame as unasked over a read it has already issued.
    const observed = retargetableSnapshot(runReadingCall(), PARKED_RUN.workflowRunId).observed;
    expect(firstState(observed).status).toBe("reading");
  });

  it("shows the previous run's phases nowhere once the pane is retargeted", async () => {
    const [firstRun, secondRun] = PROBE_RUNS;
    if (firstRun === undefined || secondRun === undefined) {
      throw new Error("the probe fixtures carry fewer than two runs");
    }
    const probe = retargetableSnapshot(runReadingCall(), firstRun.workflowRunId);
    await settle();
    expect(lastState(probe.observed).status).toBe("served");

    act(() => {
      probe.retarget(secondRun.workflowRunId);
    });

    // Reading, not run A's snapshot: A's phases and park cards must not stay renderable
    // under B's address until an effect resets them.
    expect(lastState(probe.observed).status).toBe("reading");

    await settle();
    const settled = lastState(probe.observed);
    expect(settled.status).toBe("served");
    if (settled.status === "served") {
      expect(settled.snapshot.workflowRunId).toBe(secondRun.workflowRunId);
    }
  });

  it("starts as a read in flight and settles on the served snapshot", async () => {
    const readRun = vi.fn(runReadingCall());
    const observed = retargetableSnapshot(readRun, PARKED_RUN.workflowRunId).observed;
    expect(lastState(observed).status).toBe("reading");

    await settle();
    const settled = lastState(observed);
    expect(settled.status).toBe("served");
    if (settled.status === "served") {
      expect(settled.snapshot.workflowRunId).toBe(PARKED_RUN.workflowRunId);
    }
    expect(readRun).toHaveBeenCalledExactlyOnceWith({ workflowRunId: PARKED_RUN.workflowRunId });
  });
});

/** A call answering the parked run cut to `phaseStateCount` phases, to tell calls apart. */
function phaseTruncatingCall(phaseStateCount: number): WorkflowRunReadCall {
  return async () => ({
    ...PARKED_RUN,
    phaseStates: PARKED_RUN.phaseStates.slice(0, phaseStateCount),
  });
}

function servedPhaseStateCount(state: WorkflowRunSnapshotState): number | undefined {
  return state.status === "served" ? state.snapshot.phaseStates.length : undefined;
}

describe("useWorkflowRunSnapshot — the call is half of what the read is about", () => {
  afterEach(() => {
    cleanup();
  });

  it("commits no phase from the previous call once the call is replaced", async () => {
    // Keyed on the run alone, the state agreed with itself: the render after a swap
    // committed the previous call's phases and only the passive effect took them down.
    // Reading what each COMMIT carried is the only vantage that tells the two apart.
    const probe = observeSubjectRead(useSnapshotAtFirstRound, {
      source: phaseTruncatingCall(2),
      subject: PARKED_RUN.workflowRunId,
    });
    await settle();
    expect(servedPhaseStateCount(latestCommitted(probe.committed))).toBe(2);
    const commitsBeforeSwap = probe.committed.length;

    probe.readdress({ source: phaseTruncatingCall(1), subject: PARKED_RUN.workflowRunId });

    expect(probe.committed.slice(commitsBeforeSwap).map((state) => state.status)).not.toContain(
      "served",
    );

    await settle();
    // The reset is only half the claim: a hook that reset and never re-read would leave
    // the pane reading forever.
    expect(servedPhaseStateCount(latestCommitted(probe.committed))).toBe(1);
  });

  it("negative control: a re-render at the SAME call keeps the snapshot it settled on", async () => {
    // Without this, the case above passes for a hook that reset on every render.
    const readRun = phaseTruncatingCall(2);
    const probe = observeSubjectRead(useSnapshotAtFirstRound, {
      source: readRun,
      subject: PARKED_RUN.workflowRunId,
    });
    await settle();

    probe.readdress({ source: readRun, subject: PARKED_RUN.workflowRunId });

    expect(servedPhaseStateCount(latestCommitted(probe.committed))).toBe(2);
  });
});

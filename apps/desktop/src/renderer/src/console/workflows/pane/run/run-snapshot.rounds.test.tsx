// The ROUND is what puts the read again, and nothing else does.
//
// SEPARATE FROM `run-snapshot.test.tsx` BECAUSE THE SUBJECT IS DIFFERENT. That file
// varies the answer and the address — four endings, and a port swapped underneath a run
// that did not move. Every case here holds both still and varies the round, which is
// the one input that means "the run you are showing has changed because somebody
// changed it".
//
// WHY A ROUND EXISTS AT ALL. An operator's cancel or resume comes back served, so the
// run this pane is showing has moved and the snapshot beside the controls is stale.
// The caller advances the round and the read is put once more. That is a re-arm and not
// a refresh cadence, and the difference is exactly what these two cases measure: the
// count climbs when a round advances and does not climb when a render happens.
//
// COUNTING THE CALLS IS THE INSTRUMENT because status alone cannot tell a re-read from
// a re-render — a hook that re-read on every render would report the same statuses in
// the same order while asking the daemon over and over.

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WORKFLOWS_PARKED_RUN } from "../../../bridge/scenarios/workflow-fixture-runs.js";
import { FIRST_ROUND, countingRunReadPort, observeRounds } from "./run-snapshot.test-support.js";
import { settle } from "../../WorkflowsBrowser.test-support.js";

const PARKED_RUN_ID = WORKFLOWS_PARKED_RUN.workflowRunId;

describe("useWorkflowRunSnapshot — the round is the re-arm", () => {
  afterEach(() => {
    cleanup();
  });

  it("puts the read again when the caller advances the round", async () => {
    const port = countingRunReadPort();
    const probe = observeRounds(port.growth);

    probe.renderAtRound(PARKED_RUN_ID, FIRST_ROUND);
    await settle();
    expect(port.readCount()).toBe(1);

    probe.renderAtRound(PARKED_RUN_ID, FIRST_ROUND + 1);
    // The new round is a new question, so the frame that brings it reads `reading`
    // rather than presenting the previous round's snapshot as the answer to it.
    expect(probe.observed.at(-1)?.status).toBe("reading");

    await settle();
    expect(port.readCount()).toBe(2);
    expect(probe.observed.at(-1)?.status).toBe("served");
  });

  it("negative control: re-rendering at the SAME round puts no second read", async () => {
    // Without this the case above would pass over a hook that re-read on every render,
    // which is the refresh cadence this read must not invent.
    const port = countingRunReadPort();
    const probe = observeRounds(port.growth);

    probe.renderAtRound(PARKED_RUN_ID, FIRST_ROUND);
    await settle();
    probe.renderAtRound(PARKED_RUN_ID, FIRST_ROUND);
    await settle();

    expect(port.readCount()).toBe(1);
    // And the snapshot it settled on is still there: a hook that reset on every render
    // would read forever and show nothing, which passes a call count and fails a person.
    expect(probe.observed.at(-1)?.status).toBe("served");
  });
});

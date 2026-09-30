// The round is what puts the run read again, and nothing else does. Counting calls is the
// instrument: statuses alone cannot tell a re-read from a re-render.

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PARKED_RUN, settle } from "../../workflows-probe.test-support.js";
import {
  FIRST_REFRESH,
  observeRefreshes,
  runReadingCall,
} from "./useWorkflowRunSnapshot.test-support.js";

describe("useWorkflowRunSnapshot — the round is the re-arm", () => {
  afterEach(() => {
    cleanup();
  });

  it("puts the read again when the caller advances the round", async () => {
    const readRun = vi.fn(runReadingCall());
    const probe = observeRefreshes(readRun);

    probe.renderAtRound(PARKED_RUN.workflowRunId, FIRST_REFRESH);
    await settle();
    expect(readRun).toHaveBeenCalledTimes(1);

    probe.renderAtRound(PARKED_RUN.workflowRunId, FIRST_REFRESH + 1);
    // A new round is a new question: the frame that brings it reads, it does not present the
    // previous round's snapshot as the answer.
    expect(probe.observed.at(-1)?.status).toBe("reading");

    await settle();
    expect(readRun).toHaveBeenCalledTimes(2);
    expect(probe.observed.at(-1)?.status).toBe("served");
  });

  it("negative control: re-rendering at the SAME round puts no second read", async () => {
    // Without this the case above passes over a hook that re-read on every render.
    const readRun = vi.fn(runReadingCall());
    const probe = observeRefreshes(readRun);

    probe.renderAtRound(PARKED_RUN.workflowRunId, FIRST_REFRESH);
    await settle();
    probe.renderAtRound(PARKED_RUN.workflowRunId, FIRST_REFRESH);
    await settle();

    expect(readRun).toHaveBeenCalledTimes(1);
    // A hook that reset on every render would read forever and show nothing.
    expect(probe.observed.at(-1)?.status).toBe("served");
  });
});

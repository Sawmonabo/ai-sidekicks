// The run read: an addressed pane reads its run and settles on the served snapshot, and the refresh
// is what puts the read again. Counting calls is the instrument: statuses alone cannot tell a
// re-read from a re-render.

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PARKED_RUN } from "../../workflows-probe.test-support.js";
import { settle } from "@test/helpers/settle.js";
import {
  FIRST_REFRESH,
  observeRefreshes,
  runReadingCall,
} from "./useWorkflowRunSnapshot.test-support.js";

describe("useWorkflowRunSnapshot", () => {
  afterEach(() => {
    cleanup();
  });

  it("starts as a read in flight and settles on the served snapshot", async () => {
    const readRun = vi.fn(runReadingCall());
    const probe = observeRefreshes(readRun);
    probe.renderAtRefresh(PARKED_RUN.workflowRunId, FIRST_REFRESH);
    expect(probe.observed.at(-1)?.status).toBe("reading");

    await settle();
    const settled = probe.observed.at(-1);
    expect(settled?.status).toBe("served");
    if (settled?.status === "served") {
      expect(settled.snapshot.workflowRunId).toBe(PARKED_RUN.workflowRunId);
    }
    expect(readRun).toHaveBeenCalledExactlyOnceWith({ workflowRunId: PARKED_RUN.workflowRunId });
  });

  it("puts the read again when the caller advances the refresh", async () => {
    const readRun = vi.fn(runReadingCall());
    const probe = observeRefreshes(readRun);

    probe.renderAtRefresh(PARKED_RUN.workflowRunId, FIRST_REFRESH);
    await settle();
    expect(readRun).toHaveBeenCalledTimes(1);

    probe.renderAtRefresh(PARKED_RUN.workflowRunId, FIRST_REFRESH + 1);
    // A new refresh is a new question: the frame that brings it reads, it does not present the
    // previous refresh's snapshot as the answer.
    expect(probe.observed.at(-1)?.status).toBe("reading");

    await settle();
    expect(readRun).toHaveBeenCalledTimes(2);
    expect(probe.observed.at(-1)?.status).toBe("served");
  });
});

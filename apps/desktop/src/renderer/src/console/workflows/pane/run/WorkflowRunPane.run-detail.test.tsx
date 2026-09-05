// What the pane hands the run-detail mount, on each of the two arms.
//
// Spied, never replaced, `ConsoleRoot.test.tsx`'s instrument: the run-detail slot
// carries no body anywhere in this repository, so what the pane handed it reaches no
// rendered markup and there is no other way to read it back. The real wrapper still
// renders, which is why every slot count in the sibling suites is still the pane's
// own — and why the spy lives here rather than in the shared harness, where it would
// be installed for four suites that make no claim about it.

import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WORKFLOWS_PARKED_RUN } from "../../../bridge/scenarios/workflow-fixture-runs.js";
import { RunDetailSlot } from "./slots/RunDetailSlot.js";
import {
  PARKED,
  answeringBridge,
  paneContext,
  renderPane,
  silentBridge,
} from "./WorkflowRunPane.test-support.js";

vi.mock(import("./slots/RunDetailSlot.js"), { spy: true });

describe("workflow run pane — what it hands the run-detail mount", () => {
  afterEach(() => {
    // By name rather than `clearAllMocks`, so a case reads only the render it made.
    vi.mocked(RunDetailSlot).mockClear();
  });

  it("hands over the served snapshot it is already holding, rather than the run id alone", async () => {
    // The pane puts the run read to draw its phase graph and its park cards, so the
    // snapshot is in hand at the moment this mount is composed. A body given only the
    // id would have to issue a second read for the phases, retries and outputs the
    // pane is rendering from right beside it.
    const section = renderPane(paneContext(PARKED, answeringBridge()));

    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-park").length).toBeGreaterThan(0);
    });
    const mount = vi.mocked(RunDetailSlot).mock.calls.at(-1)?.[0];
    expect(mount?.workflowRunId).toBe(WORKFLOWS_PARKED_RUN.workflowRunId);
    expect(mount?.snapshot).toStrictEqual(WORKFLOWS_PARKED_RUN);
  });

  it("negative control: a refused read hands over no snapshot key at all", async () => {
    // Absent rather than present-and-empty, and the reason the case above is about
    // the served arm specifically: a body handed a key on this arm would be shown a
    // run the daemon never described. Without this, the case above would pass over a
    // pane that spread a snapshot on every arm.
    const section = renderPane(paneContext(PARKED, silentBridge()));

    await waitFor(() => {
      expect(section.querySelector(".meridian-refusal--banner")).not.toBeNull();
    });
    const mount = vi.mocked(RunDetailSlot).mock.calls.at(-1)?.[0];
    expect(mount).toStrictEqual({ workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId });
  });
});

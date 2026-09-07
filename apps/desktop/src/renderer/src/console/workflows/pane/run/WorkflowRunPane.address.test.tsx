// The address guard: which subjects this pane will open, and what it does with the
// rest.
//
// The deck hands a pane whichever entity its layout carried, and the run view is
// reachable at a workflow definition — so "will not open" has to be a refusal the
// pane states, not a read it puts and then dresses up.

import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WORKFLOWS_PARKED_RUN } from "../../../bridge/scenarios/workflow-fixture-runs.js";
import {
  MISADDRESSED,
  PARKED,
  answeringBridge,
  paneContext,
  renderPane,
} from "./WorkflowRunPane.test-support.js";

describe("workflow run pane — with an address that names no run", () => {
  it("refuses the address rather than reading a definition id as a run id", async () => {
    // The defect: the pane took `entity.id` off any kind at all, so a definition id
    // addressed here was carried into the run read and whatever came back was shown
    // under an address that never named a run.
    const bridge = answeringBridge();
    const runRead = vi.spyOn(bridge.growth, "workflowRunRead");
    const section = renderPane(paneContext(MISADDRESSED, bridge));

    await waitFor(() => {
      expect(section.querySelector(".meridian-refusal--banner")).not.toBeNull();
    });
    expect(section.textContent ?? "").toContain("pane-address-invalid");
    // The read is not merely refused on arrival — it is never put. A pane that
    // composed one and rendered the refusal anyway would still have asked a daemon
    // about a run that does not exist.
    expect(runRead).not.toHaveBeenCalled();
  });

  it("mounts no body and offers no control for a subject it will not open", async () => {
    const section = renderPane(paneContext(MISADDRESSED, answeringBridge()));

    await waitFor(() => {
      expect(section.querySelector(".meridian-refusal--banner")).not.toBeNull();
    });
    // The refusal is the whole surface: a pane that banned the address and still
    // mounted its slots would offer to stop a run it just said it could not name.
    expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(0);
    expect(section.querySelectorAll(".meridian-workflow-run-controls__control")).toHaveLength(0);
    expect(section.querySelector(".meridian-park")).toBeNull();
  });

  it("negative control: the same pane reads on the kind it does show", async () => {
    // Without this, both cases above pass over a pane that refused every address,
    // which would make the run view unreachable rather than fail-closed.
    const bridge = answeringBridge();
    const runRead = vi.spyOn(bridge.growth, "workflowRunRead");
    const section = renderPane(paneContext(PARKED, bridge));

    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-park").length).toBeGreaterThan(0);
    });
    expect(runRead).toHaveBeenCalledWith({ workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId });
    expect(section.querySelector(".meridian-refusal--banner")).toBeNull();
  });
});

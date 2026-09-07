// The controls the PANE mounts reach the port, and the refusal on screen is the
// port's own.
//
// This is the mount-site half of the claim, and it is a separate suite because it is a
// separate defect. `run-control-dispatch.test.tsx` proves the hook calls; the pane
// could still hand `OperatorControls` a hand-composed refusal and every one of those
// cases would stay green — which is exactly the shape this family shipped before: both
// controls mounted as objects claiming the operation was "not on the bridge yet",
// under this family's own origin, for two operations `bridge/growth-operations/
// workflows.ts` has carried all along.
//
// The assertion is therefore on the SENTENCE, and on the one sentence no mount site can
// author: `growth-port.ts` composes it from the growth slate row, so a pane that had not
// called would have to have copied it — and a reworded row moves the expectation and the
// screen together.
//
// AND ON WHERE IT LANDS, because the sentence alone cannot tell the two presses apart.
// Both operations sit on ONE growth slate row — the row names the whole nine-method
// workflow group — so `growthUnavailable` composes the same words for either, and what
// distinguishes them on screen is that each answer renders inside the form of the
// button that asked. That is the property an operator actually depends on, so it is the
// one asserted rather than a difference in copy that does not exist.
//
// Under the fixture the mutations are deliberately unserved (`fixture-growth-port.ts`
// serves the four workflow READS and no writes), so the refusal a press earns here is
// the wire-unregistered one. That is the point rather than a limitation: it is what a
// release build renders today, and it is reached by asking.

import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { growthUnavailable } from "../../../bridge/index.js";
import {
  PARKED,
  answeringBridge,
  paneContext,
  renderPane,
} from "./WorkflowRunPane.test-support.js";

/**
 * The sentence the port composes for either run-control operation.
 *
 * Read from the real producer rather than copied, and read ONCE because the two
 * operations share a slate row — restating it per operation would suggest a difference
 * the corpus does not have.
 */
const PORT_REFUSAL_SENTENCE = growthUnavailable("workflowRunCancel").detail;

/** The button an operator presses, found the way an operator finds it. */
function actionNamed(section: HTMLElement, label: string): HTMLElement {
  const pressed = [...section.querySelectorAll(".meridian-workflow-run-controls__action")].find(
    (candidate) => candidate.textContent?.includes(label) === true,
  );
  if (!(pressed instanceof HTMLElement)) {
    throw new Error(`the pane drew no control labelled ${label}`);
  }
  return pressed;
}

/** The whole control one button belongs to — the form that holds its answer too. */
function controlAround(section: HTMLElement, label: string): HTMLElement {
  const control = actionNamed(section, label).closest(".meridian-workflow-run-controls__control");
  if (!(control instanceof HTMLElement)) {
    throw new Error(`the ${label} button sits inside no control`);
  }
  return control;
}

describe("the run pane's operator controls ask the port", () => {
  it("renders the growth port's own refusal after a cancel is pressed", async () => {
    const section = renderPane(paneContext(PARKED, answeringBridge()));

    // Nothing about the wire is on screen before the press. A pane that composed its
    // own refusal showed one immediately, which is the visible half of the defect: it
    // reported a wire's absence without having consulted the wire.
    expect(section.textContent).not.toContain(PORT_REFUSAL_SENTENCE);

    fireEvent.click(actionNamed(section, "Cancel this run"));
    await waitFor(() => {
      expect(controlAround(section, "Cancel this run").textContent).toContain(
        PORT_REFUSAL_SENTENCE,
      );
    });
    // And the control is still there to press again — rule 9, asserted on the pane
    // rather than only on the component that renders it.
    expect(actionNamed(section, "Cancel this run")).toBeInstanceOf(HTMLElement);
  });

  it("leaves the control that was not pressed carrying no answer", async () => {
    // The two controls are separately asked and separately answered. A pane that
    // published one outcome for both presses would satisfy the case above and put a
    // refusal under a button nobody touched.
    const section = renderPane(paneContext(PARKED, answeringBridge()));
    fireEvent.click(actionNamed(section, "Resume this run"));
    await waitFor(() => {
      expect(controlAround(section, "Resume this run").textContent).toContain(
        PORT_REFUSAL_SENTENCE,
      );
    });
    expect(controlAround(section, "Cancel this run").textContent).not.toContain(
      PORT_REFUSAL_SENTENCE,
    );
  });

  it("negative control: an unpressed pane carries no refusal on either control", async () => {
    // Without this, the two cases above would be satisfied by a pane that rendered the
    // refusal on mount — which is the defect, dressed as a pass.
    const section = renderPane(paneContext(PARKED, answeringBridge()));
    await waitFor(() => {
      expect(section.querySelector(".meridian-workflow-run-controls")).not.toBeNull();
    });
    expect(controlAround(section, "Cancel this run").textContent).not.toContain(
      PORT_REFUSAL_SENTENCE,
    );
    expect(controlAround(section, "Resume this run").textContent).not.toContain(
      PORT_REFUSAL_SENTENCE,
    );
  });
});

// What the controls do with an ANSWER, which is the half a press earns.
//
// SEPARATE FROM `OperatorControls.test.tsx` BECAUSE THE SUBJECT IS DIFFERENT. That
// file is about what an operator can compose and submit — the reason field, the
// picker, the scoping of both to one run. Every case here holds the form still and
// varies the `WorkflowRunControlOutcome`, which is the input a form cannot produce.
//
// AND IT IS WHERE THE FIX IS ASSERTED. Both controls used to be mounted as
// hand-composed refusals claiming their operations were "not on the bridge yet",
// while `bridge/growth-operations/workflows.ts` carried both — so the first group's
// old shape was a refused-control group, and these cases assert its opposite:
// eligibility is a daemon adjudication nothing here can perform before it asks, so a
// press puts the question and the answer renders BESIDE the button, never in place of
// it and never as a pre-press claim about a wire this component never consulted.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { GrowthPort } from "../../../bridge/index.js";
import { OperatorControls, type OperatorControlsProps } from "./OperatorControls.js";
import { IDLE_RUN_CONTROL_OUTCOME, actAlreadyInFlightRefusal } from "./run-controls.js";

/**
 * The one address every case renders at.
 *
 * The port is a subject TOKEN and nothing calls it — this component issues no read —
 * so it is cast rather than built, the idiom the two suites beside this one share.
 */
const RUN_A_ADDRESS = { growth: {} as GrowthPort, workflowRunId: "run-a" } as const;

/** Both controls offered with nothing pressed yet — what an opened pane renders. */
const NOTHING_PRESSED: OperatorControlsProps = {
  ...RUN_A_ADDRESS,
  cancel: { cancel: vi.fn(), outcome: IDLE_RUN_CONTROL_OUTCOME },
  resume: { resume: vi.fn(), versionChain: [], outcome: IDLE_RUN_CONTROL_OUTCOME },
};

describe("a control is offered, and a refusal stands beside it rather than instead of it", () => {
  it("draws both buttons before anything has been pressed", () => {
    render(<OperatorControls {...NOTHING_PRESSED} />);
    // The whole of the fix. These two used to be mounted as hand-composed refusals
    // claiming their operations were not on the bridge, while the growth port carried
    // both — so an operator was told an act was unreachable that nothing had checked.
    expect(screen.queryAllByRole("button")).toHaveLength(2);
  });

  it("says nothing about an act nobody has performed", () => {
    render(<OperatorControls {...NOTHING_PRESSED} />);
    // `idle` draws no absence and no refusal: reporting on a question never put is
    // the conflation the five kinds of nothing exist to prevent.
    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });

  it("renders a refused press verbatim AND keeps the control pressable", () => {
    const cancel = vi.fn();
    render(
      <OperatorControls
        {...RUN_A_ADDRESS}
        cancel={{
          cancel,
          outcome: { kind: "refused", refusal: actAlreadyInFlightRefusal("cancel") },
        }}
        resume={{ resume: vi.fn(), versionChain: [], outcome: IDLE_RUN_CONTROL_OUTCOME }}
      />,
    );
    expect(screen.getByText("act-already-in-flight")).toBeDefined();
    const button = screen.getByRole("button", { name: /cancel this run/iu });
    expect(button.hasAttribute("disabled")).toBe(false);
    // Rule 9 exactly: the refusal joined the control, it did not replace it, so the
    // operator can act again once the outstanding call settles.
    fireEvent.click(button);
    expect(cancel).toHaveBeenCalledWith(undefined);
  });

  it("negative control: the refusal code is the raiser's own and is not reworded", () => {
    // Without this the case above would pass over a component that printed a fixed
    // sentence of its own for every refusal, which is the second vocabulary this
    // surface must never grow: the port's `wire-unregistered` and the daemon's
    // `workflow.*` codes both reach this same renderer untranslated.
    const refusal = actAlreadyInFlightRefusal("resume");
    render(
      <OperatorControls
        {...RUN_A_ADDRESS}
        cancel={{ cancel: vi.fn(), outcome: IDLE_RUN_CONTROL_OUTCOME }}
        resume={{ resume: vi.fn(), versionChain: [], outcome: { kind: "refused", refusal } }}
      />,
    );
    expect(screen.getByText(refusal.code)).toBeDefined();
    expect(screen.getByText(refusal.detail)).toBeDefined();
  });

  it("quotes the run state a served act answered with, wire-verbatim", () => {
    render(
      <OperatorControls
        {...RUN_A_ADDRESS}
        cancel={{
          cancel: vi.fn(),
          outcome: { kind: "settled", runState: "cancelled", detail: "This run is cancelled." },
        }}
        resume={{ resume: vi.fn(), versionChain: [], outcome: IDLE_RUN_CONTROL_OUTCOME }}
      />,
    );
    // The wire word and not a paraphrase of it, so an operator who then reads
    // `cancelled` on the run sees the same string the settlement showed them.
    expect(screen.getByText("cancelled")).toBeDefined();
    expect(screen.getByText("This run is cancelled.")).toBeDefined();
  });
});

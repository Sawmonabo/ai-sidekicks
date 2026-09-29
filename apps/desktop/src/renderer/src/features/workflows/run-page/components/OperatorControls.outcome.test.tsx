// What the controls do with an ANSWER, which is the half a press earns.
//
// Every case but the last group holds the form still and varies the
// `WorkflowRunControlOutcome`, the input a form cannot produce (`OperatorControls.test.tsx`
// is what an operator can compose). Eligibility is the daemon's, so a press puts the
// question and the answer renders BESIDE the button, never in place of it and never as a
// pre-press claim. The last group mounts the controls over the real dispatcher, because
// which control an answer lands under is decided between the two.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OperatorControls, type OperatorControlsProps } from "./OperatorControls.js";
import { heldCancelCalls } from "../hooks/useRunControlDispatch.test-support.js";
import {
  useRunControlDispatch,
  type WorkflowRunControlCalls,
} from "../hooks/useRunControlDispatch.js";
import { IDLE_RUN_CONTROL_OUTCOME, actAlreadyInFlightRefusal } from "../run-controls.js";
import { settle } from "../../workflows-probe.test-support.js";

/** The one address every case renders at. */
const RUN_A_ADDRESS = { workflowRunId: "run-a" } as const;

/** Both controls offered with nothing pressed yet — what an opened pane renders. */
const NOTHING_PRESSED: OperatorControlsProps = {
  ...RUN_A_ADDRESS,
  cancel: { cancel: vi.fn(), outcome: IDLE_RUN_CONTROL_OUTCOME },
  resume: { resume: vi.fn(), versionChain: [], outcome: IDLE_RUN_CONTROL_OUTCOME },
};

describe("a control is offered, and a refusal stands beside it rather than instead of it", () => {
  it("draws both buttons before anything has been pressed", () => {
    render(<OperatorControls {...NOTHING_PRESSED} />);
    // Nothing is decided in advance: both acts are offered until the daemon answers.
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
    // The refusal joined the control, it did not replace it, so the operator can act
    // again once the outstanding call settles.
    fireEvent.click(button);
    expect(cancel).toHaveBeenCalledWith(undefined);
  });

  it("negative control: the refusal code is the raiser's own and is not reworded", () => {
    // Without this the case above would pass over a component that printed a fixed
    // sentence of its own for every refusal, a second vocabulary this component must
    // never grow.
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
          outcome: { kind: "settled", runState: "canceled", detail: "This run is canceled." },
        }}
        resume={{ resume: vi.fn(), versionChain: [], outcome: IDLE_RUN_CONTROL_OUTCOME }}
      />,
    );
    // The wire word and not a paraphrase of it, so an operator who then reads
    // `canceled` on the run sees the same string the settlement showed them.
    expect(screen.getByText("canceled")).toBeDefined();
    expect(screen.getByText("This run is canceled.")).toBeDefined();
  });
});

/** The controls wired to the real dispatcher, at the one run every case presses on. */
function ControlsOverDispatch(props: {
  readonly calls: WorkflowRunControlCalls;
}): React.JSX.Element {
  const controls = useRunControlDispatch(props.calls, RUN_A_ADDRESS.workflowRunId);
  return (
    <OperatorControls
      {...RUN_A_ADDRESS}
      cancel={controls.cancel}
      resume={{ ...controls.resume, versionChain: [] }}
    />
  );
}

/** The outcome line a served press left inside the control that button belongs to. */
function outcomeLineOf(buttonName: RegExp): Element | null {
  const control = screen
    .getByRole("button", { name: buttonName })
    .closest(".meridian-workflow-run-controls__control");
  return control?.querySelector(".meridian-workflow-run-controls__outcome") ?? null;
}

describe("each control carries only the answer to its own press", () => {
  it("leaves resume carrying no answer after a cancel is pressed and served", async () => {
    const held = heldCancelCalls();
    render(<ControlsOverDispatch calls={held.calls} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /cancel this run/iu }));
    });
    await act(async () => {
      held.serve();
    });
    await settle();

    expect(outcomeLineOf(/cancel this run/iu)?.textContent).toContain("canceled");
    expect(outcomeLineOf(/resume this run/iu)).toBeNull();
  });

  it("leaves cancel carrying no answer after a resume is pressed and served", async () => {
    const held = heldCancelCalls();
    render(<ControlsOverDispatch calls={held.calls} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /resume this run/iu }));
    });
    await settle();

    expect(outcomeLineOf(/resume this run/iu)?.textContent).toContain("running");
    expect(outcomeLineOf(/cancel this run/iu)).toBeNull();
  });
});

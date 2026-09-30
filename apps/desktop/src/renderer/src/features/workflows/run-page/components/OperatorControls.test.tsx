// What the operator controls send: the reason as typed, nothing past the byte bound, and a re-pin
// target only when it is on the chain now on screen; and the state a re-parked run answers with
// never reaches the screen.

import { WORKFLOW_CANCEL_REASON_BYTE_CAP } from "@ai-sidekicks/contracts";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OperatorControls } from "./OperatorControls.js";
import {
  IDLE_RUN_CONTROL_OUTCOME,
  WORKFLOW_RUN_RE_PARKED_STATE,
  type WorkflowVersionChoice,
} from "../run-controls.js";

/** The run the controls hold their two fields against. */
const RUN_A_ADDRESS = { workflowRunId: "run-a" } as const;

const VERSION_CHAIN: readonly WorkflowVersionChoice[] = [
  { workflowVersionId: "wfv-03", label: "Version 3", isCurrentPin: true },
  { workflowVersionId: "wfv-02", label: "Version 2", isCurrentPin: false },
];

/** The same run's chain after a version lands, with the chosen one no longer on it. */
const CHAIN_WITHOUT_CHOICE: readonly WorkflowVersionChoice[] = [
  { workflowVersionId: "wfv-09", label: "Version 9", isCurrentPin: true },
];

function admitted(props: {
  readonly versionChain: readonly WorkflowVersionChoice[];
  readonly resume: () => void;
}): React.JSX.Element {
  return (
    <OperatorControls
      {...RUN_A_ADDRESS}
      cancel={{ cancel: vi.fn(), outcome: IDLE_RUN_CONTROL_OUTCOME }}
      resume={{
        resume: props.resume,
        versionChain: props.versionChain,
        outcome: IDLE_RUN_CONTROL_OUTCOME,
      }}
    />
  );
}

/** Choose `wfv-02` on the chain before, then serve `versionChain` for the same run. */
function chooseThenMoveChain(
  versionChain: readonly WorkflowVersionChoice[],
  resume: () => void,
): void {
  const rendered = render(admitted({ versionChain: VERSION_CHAIN, resume }));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "wfv-02" } });
  rendered.rerender(admitted({ versionChain, resume }));
}

describe("no wire spelling reaches the screen", () => {
  it("does not render the state a re-parked run answers with", () => {
    const { container } = render(
      <OperatorControls
        {...RUN_A_ADDRESS}
        cancel={{ cancel: vi.fn(), outcome: IDLE_RUN_CONTROL_OUTCOME }}
        resume={{ resume: vi.fn(), versionChain: [], outcome: IDLE_RUN_CONTROL_OUTCOME }}
      />,
    );

    expect(container.textContent ?? "").toContain("re-parks on its next dispatch");
    expect(container.textContent ?? "").not.toContain(WORKFLOW_RUN_RE_PARKED_STATE);
  });
});

describe("cancel is never gated, queued or disabled", () => {
  it("carries the operator's reason through verbatim", () => {
    const cancel = vi.fn();
    render(
      <OperatorControls
        {...RUN_A_ADDRESS}
        cancel={{ cancel, outcome: IDLE_RUN_CONTROL_OUTCOME }}
        resume={{ resume: vi.fn(), versionChain: [], outcome: IDLE_RUN_CONTROL_OUTCOME }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "superseded" } });
    fireEvent.click(screen.getByRole("button", { name: /cancel this run/iu }));
    expect(cancel).toHaveBeenCalledWith("superseded");
  });

  it("refuses a reason past the bound loudly, and still never disables the button", () => {
    const cancel = vi.fn();
    render(
      <OperatorControls
        {...RUN_A_ADDRESS}
        cancel={{ cancel, outcome: IDLE_RUN_CONTROL_OUTCOME }}
        resume={{ resume: vi.fn(), versionChain: [], outcome: IDLE_RUN_CONTROL_OUTCOME }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "a".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP + 1) },
    });
    expect(screen.getByText("reason-past-bound")).toBeDefined();
    const button = screen.getByRole("button", { name: /cancel this run/iu });
    // The refused act does not travel and the control stays pressable; cancel is never disabled.
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("the re-pin is explicit or absent, and never resolves a latest", () => {
  it("carries the chosen version as the required member of the re-pin", () => {
    const resume = vi.fn();
    render(
      <OperatorControls
        {...RUN_A_ADDRESS}
        cancel={{ cancel: vi.fn(), outcome: IDLE_RUN_CONTROL_OUTCOME }}
        resume={{ resume, versionChain: VERSION_CHAIN, outcome: IDLE_RUN_CONTROL_OUTCOME }}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "wfv-02" } });
    fireEvent.click(screen.getByRole("button", { name: /resume this run/iu }));
    expect(resume).toHaveBeenCalledWith({ targetWorkflowVersionId: "wfv-02" });
  });

  // A `<select>` handed a value no option carries displays nothing, while the held id would still
  // be spent: Resume would send a target the operator cannot see.
  it("resumes with no target rather than one that left the chain", () => {
    const resume = vi.fn();
    chooseThenMoveChain(CHAIN_WITHOUT_CHOICE, resume);
    fireEvent.click(screen.getByRole("button", { name: /resume this run/iu }));
    expect(resume).toHaveBeenCalledWith(undefined);
    expect(resume).not.toHaveBeenCalledWith({ targetWorkflowVersionId: "wfv-02" });
  });
});

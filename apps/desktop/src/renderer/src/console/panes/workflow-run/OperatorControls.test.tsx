// What the controls must never do, asserted as things they cannot do.
//
// Four rules, four groups. Each one is checked on the shape rather than on the copy
// — a `disabled` attribute, an option list, the argument a call received — because
// the copy is this family's to reword and the shape is the rule.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OperatorControls, type OperatorControlsProps } from "./OperatorControls.js";
import {
  WORKFLOW_CANCEL_REASON_BYTE_CAP,
  unregisteredRunControl,
  type WorkflowVersionChoice,
} from "./run-controls.js";

/** Both controls refused, which is every arm this build can actually reach. */
const BOTH_REFUSED: OperatorControlsProps = {
  cancel: { kind: "refused", refusal: unregisteredRunControl("cancel") },
  resume: { kind: "refused", refusal: unregisteredRunControl("resume") },
};

const VERSION_CHAIN: readonly WorkflowVersionChoice[] = [
  { workflowVersionId: "wfv-03", label: "Version 3", isCurrentPin: true },
  { workflowVersionId: "wfv-02", label: "Version 2", isCurrentPin: false },
];

describe("a refused control renders its refusal and offers no press", () => {
  it("draws no button on either refused arm", () => {
    render(<OperatorControls {...BOTH_REFUSED} />);
    // Not "a disabled button": a control that leads nowhere is ABSENT, and the
    // refusal stands where it would have been. A disabled button is a promise that
    // something could enable it, and on this build nothing can.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("renders both refusal codes verbatim", () => {
    render(<OperatorControls {...BOTH_REFUSED} />);
    expect(screen.getAllByText("wire-unregistered")).toHaveLength(2);
  });

  it("negative control: an admitted pair draws two buttons", () => {
    // Without this, the first case would pass over a component that rendered no
    // button on any arm at all.
    render(
      <OperatorControls
        cancel={{ kind: "admitted", cancel: vi.fn() }}
        resume={{ kind: "admitted", resume: vi.fn(), versionChain: [] }}
      />,
    );
    expect(screen.queryAllByRole("button")).toHaveLength(2);
  });
});

describe("cancel is never gated, queued or disabled", () => {
  it("submits with no reason when the operator gave none", () => {
    const cancel = vi.fn();
    render(
      <OperatorControls
        cancel={{ kind: "admitted", cancel }}
        resume={{ kind: "refused", refusal: unregisteredRunControl("resume") }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel this run/iu }));
    expect(cancel).toHaveBeenCalledWith(undefined);
  });

  it("carries the operator's reason through verbatim", () => {
    const cancel = vi.fn();
    render(
      <OperatorControls
        cancel={{ kind: "admitted", cancel }}
        resume={{ kind: "refused", refusal: unregisteredRunControl("resume") }}
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
        cancel={{ kind: "admitted", cancel }}
        resume={{ kind: "refused", refusal: unregisteredRunControl("resume") }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "a".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP + 1) },
    });
    expect(screen.getByText("reason-past-bound")).toBeDefined();
    const button = screen.getByRole("button", { name: /cancel this run/iu });
    // The refused act does not travel AND the control stays pressable — rule 9 keeps
    // a refusal beside its control rather than removing it, and rule 1 of this
    // surface says cancel is never disabled on any path.
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("negative control: a reason exactly at the bound travels", () => {
    // Without this, the case above would pass over a component that refused every
    // reason, or that never called through at all.
    const cancel = vi.fn();
    const atBound = "a".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP);
    render(
      <OperatorControls
        cancel={{ kind: "admitted", cancel }}
        resume={{ kind: "refused", refusal: unregisteredRunControl("resume") }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: atBound } });
    expect(screen.queryByText("reason-past-bound")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /cancel this run/iu }));
    expect(cancel).toHaveBeenCalledWith(atBound);
  });
});

describe("the re-pin is explicit or absent, and never resolves a latest", () => {
  it("offers no picker when no version chain was read", () => {
    render(
      <OperatorControls
        cancel={{ kind: "refused", refusal: unregisteredRunControl("cancel") }}
        resume={{ kind: "admitted", resume: vi.fn(), versionChain: [] }}
      />,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("resumes without a re-pin while nothing is chosen", () => {
    const resume = vi.fn();
    render(
      <OperatorControls
        cancel={{ kind: "refused", refusal: unregisteredRunControl("cancel") }}
        resume={{ kind: "admitted", resume, versionChain: VERSION_CHAIN }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /resume this run/iu }));
    expect(resume).toHaveBeenCalledWith(undefined);
  });

  it("carries the chosen version as the required member of the re-pin", () => {
    const resume = vi.fn();
    render(
      <OperatorControls
        cancel={{ kind: "refused", refusal: unregisteredRunControl("cancel") }}
        resume={{ kind: "admitted", resume, versionChain: VERSION_CHAIN }}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "wfv-02" } });
    fireEvent.click(screen.getByRole("button", { name: /resume this run/iu }));
    expect(resume).toHaveBeenCalledWith({ targetWorkflowVersionId: "wfv-02" });
  });

  it("offers exactly the chain the caller read, plus the no-re-pin choice", () => {
    render(
      <OperatorControls
        cancel={{ kind: "refused", refusal: unregisteredRunControl("cancel") }}
        resume={{ kind: "admitted", resume: vi.fn(), versionChain: VERSION_CHAIN }}
      />,
    );
    // The value list is the assertion, not the labels: a "latest" option would have
    // to carry SOME value, and any value here that is not a version the caller read
    // is the server-resolved latest this control exists to refuse.
    expect(
      screen.getAllByRole("option").map((option) => (option as HTMLOptionElement).value),
    ).toStrictEqual(["", "wfv-03", "wfv-02"]);
  });

  it("negative control: an empty chain renders no options at all", () => {
    // Without this, the option-list case would pass over a component that rendered
    // its options from a source other than the chain it was handed.
    render(
      <OperatorControls
        cancel={{ kind: "refused", refusal: unregisteredRunControl("cancel") }}
        resume={{ kind: "admitted", resume: vi.fn(), versionChain: [] }}
      />,
    );
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});

// What the forms must never do, asserted on shape (a `disabled` attribute, an option list, the
// argument a call received) rather than copy. Outcomes are in `OperatorControls.outcome.test.tsx`
// and the chain moving under a held selection in `OperatorControls.chain-move.test.tsx`.

import { WORKFLOW_CANCEL_REASON_BYTE_CAP } from "@ai-sidekicks/contracts";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OperatorControls } from "./OperatorControls.js";
import {
  IDLE_RUN_CONTROL_OUTCOME,
  WORKFLOW_RUN_RE_PARKED_STATE,
  type WorkflowVersionChoice,
} from "../run-controls.js";

/** The run the controls hold their two fields against; only the retarget group moves. */
const RUN_A_ADDRESS = { workflowRunId: "run-a" } as const;

/**
 * The picker's own value for "resume without re-pinning". The component's `NO_REPIN` is
 * module-private, so this restates what the DOM shows.
 */
const NO_REPIN_VALUE = "";

const VERSION_CHAIN: readonly WorkflowVersionChoice[] = [
  { workflowVersionId: "wfv-03", label: "Version 3", isCurrentPin: true },
  { workflowVersionId: "wfv-02", label: "Version 2", isCurrentPin: false },
];

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
  it("submits with no reason when the operator gave none", () => {
    const cancel = vi.fn();
    render(
      <OperatorControls
        {...RUN_A_ADDRESS}
        cancel={{ cancel, outcome: IDLE_RUN_CONTROL_OUTCOME }}
        resume={{ resume: vi.fn(), versionChain: [], outcome: IDLE_RUN_CONTROL_OUTCOME }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel this run/iu }));
    expect(cancel).toHaveBeenCalledWith(undefined);
  });

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

  it("says so where the operator is looking, even with the disclosure closed", () => {
    // An operator who collapsed the region and pressed Cancel must still be told why nothing was
    // sent.
    const cancel = vi.fn();
    const { container } = render(
      <OperatorControls
        {...RUN_A_ADDRESS}
        cancel={{ cancel, outcome: IDLE_RUN_CONTROL_OUTCOME }}
        resume={{ resume: vi.fn(), versionChain: [], outcome: IDLE_RUN_CONTROL_OUTCOME }}
      />,
    );
    const disclosure = container.querySelector("details");
    if (!(disclosure instanceof HTMLDetailsElement)) {
      throw new Error("the cancel control rendered no disclosure");
    }

    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "a".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP + 1) },
    });
    // The operator never opened it, or closed it again.
    expect(disclosure.open).toBe(false);
    // The claim is where the refusal is: outside the collapsed region.
    expect(disclosure.contains(screen.getByText("reason-past-bound"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /cancel this run/iu }));

    expect(cancel).not.toHaveBeenCalled();
    // The press points at the field to shorten.
    expect(disclosure.open).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText("Reason"));
  });

  it("negative control: an accepted press leaves the disclosure as the operator left it", () => {
    // Without this, the case above would pass over a control that opened the disclosure on every
    // submission, overriding the operator's arrangement.
    const cancel = vi.fn();
    const { container } = render(
      <OperatorControls
        {...RUN_A_ADDRESS}
        cancel={{ cancel, outcome: IDLE_RUN_CONTROL_OUTCOME }}
        resume={{ resume: vi.fn(), versionChain: [], outcome: IDLE_RUN_CONTROL_OUTCOME }}
      />,
    );
    const disclosure = container.querySelector("details");

    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "superseded" } });
    fireEvent.click(screen.getByRole("button", { name: /cancel this run/iu }));

    expect(cancel).toHaveBeenCalledWith("superseded");
    expect(disclosure instanceof HTMLDetailsElement ? disclosure.open : true).toBe(false);
  });

  it("negative control: a reason exactly at the bound travels", () => {
    // Without this, the case above would pass over a component that refused every reason.
    const cancel = vi.fn();
    const atBound = "a".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP);
    render(
      <OperatorControls
        {...RUN_A_ADDRESS}
        cancel={{ cancel, outcome: IDLE_RUN_CONTROL_OUTCOME }}
        resume={{ resume: vi.fn(), versionChain: [], outcome: IDLE_RUN_CONTROL_OUTCOME }}
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
        {...RUN_A_ADDRESS}
        cancel={{ cancel: vi.fn(), outcome: IDLE_RUN_CONTROL_OUTCOME }}
        resume={{ resume: vi.fn(), versionChain: [], outcome: IDLE_RUN_CONTROL_OUTCOME }}
      />,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("resumes without a re-pin while nothing is chosen", () => {
    const resume = vi.fn();
    render(
      <OperatorControls
        {...RUN_A_ADDRESS}
        cancel={{ cancel: vi.fn(), outcome: IDLE_RUN_CONTROL_OUTCOME }}
        resume={{ resume, versionChain: VERSION_CHAIN, outcome: IDLE_RUN_CONTROL_OUTCOME }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /resume this run/iu }));
    expect(resume).toHaveBeenCalledWith(undefined);
  });

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

  it("offers exactly the chain the caller read, plus the no-re-pin choice", () => {
    render(
      <OperatorControls
        {...RUN_A_ADDRESS}
        cancel={{ cancel: vi.fn(), outcome: IDLE_RUN_CONTROL_OUTCOME }}
        resume={{ resume: vi.fn(), versionChain: VERSION_CHAIN, outcome: IDLE_RUN_CONTROL_OUTCOME }}
      />,
    );
    // The value list is the assertion: a "latest" option would carry some value that is not a
    // version the caller read.
    expect(
      screen.getAllByRole("option").map((option) => (option as HTMLOptionElement).value),
    ).toStrictEqual(["", "wfv-03", "wfv-02"]);
  });

  it("negative control: an empty chain renders no options at all", () => {
    // Without this, the option-list case would pass over options drawn from another source.
    render(
      <OperatorControls
        {...RUN_A_ADDRESS}
        cancel={{ cancel: vi.fn(), outcome: IDLE_RUN_CONTROL_OUTCOME }}
        resume={{ resume: vi.fn(), versionChain: [], outcome: IDLE_RUN_CONTROL_OUTCOME }}
      />,
    );
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});

/*
 * The pane is retargeted in place: the layout rewrites its address and hands the same instance
 * another run. A chain is per run, so run A's chosen id is in run B's chain nowhere, and a
 * `<select>` matching no option displays its first one while the state still holds run A's id,
 * so Resume would send a target the operator never chose.
 */
describe("the two fields are answers about one run", () => {
  const RUN_B_CHAIN: readonly WorkflowVersionChoice[] = [
    { workflowVersionId: "wfv-09", label: "Version 9", isCurrentPin: true },
  ];

  function admitted(props: {
    readonly workflowRunId: string;
    readonly versionChain: readonly WorkflowVersionChoice[];
    readonly resume: () => void;
  }): React.JSX.Element {
    return (
      <OperatorControls
        workflowRunId={props.workflowRunId}
        cancel={{ cancel: vi.fn(), outcome: IDLE_RUN_CONTROL_OUTCOME }}
        resume={{
          resume: props.resume,
          versionChain: props.versionChain,
          outcome: IDLE_RUN_CONTROL_OUTCOME,
        }}
      />
    );
  }

  function typedReason(): string {
    const field = screen.getByLabelText("Reason");
    return field instanceof HTMLTextAreaElement ? field.value : "";
  }

  function chosenRepin(): string {
    const picker = screen.getByRole("combobox");
    return picker instanceof HTMLSelectElement ? picker.value : "";
  }

  /** Fill both fields on run A, then hand the same controls run B. */
  function fillRunAThenRetarget(resume: () => void): ReturnType<typeof render> {
    const rendered = render(
      admitted({ workflowRunId: "run-a", versionChain: VERSION_CHAIN, resume }),
    );
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "superseded" } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "wfv-02" } });
    expect(typedReason()).toBe("superseded");
    expect(chosenRepin()).toBe("wfv-02");
    rendered.rerender(admitted({ workflowRunId: "run-b", versionChain: RUN_B_CHAIN, resume }));
    return rendered;
  }

  it("carries neither the reason nor the re-pin target into the next run", () => {
    fillRunAThenRetarget(vi.fn());
    expect(typedReason()).toBe("");
    expect(chosenRepin()).toBe(NO_REPIN_VALUE);
    // The line quoting the target is gone with it.
    expect(screen.queryByText(/resuming onto/iu)).toBeNull();
  });

  it("resumes the new run with no target rather than the one chosen for the old one", () => {
    const resume = vi.fn();
    fillRunAThenRetarget(resume);
    fireEvent.click(screen.getByRole("button", { name: /resume this run/iu }));
    expect(resume).toHaveBeenCalledWith(undefined);
    expect(resume).not.toHaveBeenCalledWith({ targetWorkflowVersionId: "wfv-02" });
  });

  it("negative control: run A's chosen version is in run B's chain nowhere", () => {
    // The premise of the case above, asserted: an id the new chain contained would be a legal
    // choice there.
    expect(RUN_B_CHAIN.map((choice) => choice.workflowVersionId)).not.toContain("wfv-02");
  });

  it("negative control: a re-render at the SAME run keeps both answers", () => {
    // Without this, the cases above pass for fields that cleared on every render.
    const resume = vi.fn();
    const rendered = render(
      admitted({ workflowRunId: "run-a", versionChain: VERSION_CHAIN, resume }),
    );
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "superseded" } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "wfv-02" } });
    rendered.rerender(admitted({ workflowRunId: "run-a", versionChain: VERSION_CHAIN, resume }));

    expect(typedReason()).toBe("superseded");
    expect(chosenRepin()).toBe("wfv-02");
  });
});

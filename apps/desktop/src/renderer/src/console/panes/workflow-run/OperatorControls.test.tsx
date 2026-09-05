// What the controls must never do, asserted as things they cannot do.
//
// Four rules, four groups. Each one is checked on the shape rather than on the copy
// — a `disabled` attribute, an option list, the argument a call received — because
// the copy is this family's to reword and the shape is the rule.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { GrowthPort } from "../../bridge/index.js";
import { OperatorControls, type OperatorControlsProps } from "./OperatorControls.js";
import {
  WORKFLOW_CANCEL_REASON_BYTE_CAP,
  unregisteredRunControl,
  type WorkflowVersionChoice,
} from "./run-controls.js";

/**
 * The address the controls hold their two fields against.
 *
 * The port is a subject TOKEN and nothing calls it — this component issues no read —
 * so it is cast rather than built, the idiom `WorkflowRunPane.test-support.tsx` states
 * for the pane context: standing a fixture bridge up to supply an identity would make
 * the setup the subject. Every case but the retarget group below renders at this one
 * address, because none of them moves.
 */
const RUN_A_ADDRESS = { growth: {} as GrowthPort, workflowRunId: "run-a" } as const;

/**
 * The picker's own value for "resume without re-pinning".
 *
 * The component's `NO_REPIN` is module-private and stays that way — it is the empty
 * string because that is what an unselected `<option>` carries, and publishing it would
 * be publishing a fact about HTML. Restated here as what the DOM shows, which is the
 * only thing these cases read.
 */
const NO_REPIN_VALUE = "";

/** Both controls refused, which is every arm this build can actually reach. */
const BOTH_REFUSED: OperatorControlsProps = {
  ...RUN_A_ADDRESS,
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
        {...RUN_A_ADDRESS}
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
        {...RUN_A_ADDRESS}
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
        {...RUN_A_ADDRESS}
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
        {...RUN_A_ADDRESS}
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

  it("says so where the operator is looking, even with the disclosure closed", () => {
    // The finding exactly. The refusal used to live inside the collapsible region, so
    // an operator who typed a long reason, collapsed it and pressed Cancel saw a
    // button that did nothing and no word about why.
    const cancel = vi.fn();
    const { container } = render(
      <OperatorControls
        {...RUN_A_ADDRESS}
        cancel={{ kind: "admitted", cancel }}
        resume={{ kind: "refused", refusal: unregisteredRunControl("resume") }}
      />,
    );
    const disclosure = container.querySelector("details");
    if (!(disclosure instanceof HTMLDetailsElement)) {
      throw new Error("the cancel control rendered no disclosure");
    }

    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "a".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP + 1) },
    });
    // The state the defect needed: the operator never opened it, or closed it again.
    expect(disclosure.open).toBe(false);
    // The refusal is readable from there, which is a claim about WHERE it is rather
    // than about whether it exists — the old markup rendered it too, out of sight.
    expect(disclosure.contains(screen.getByText("reason-past-bound"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /cancel this run/iu }));

    expect(cancel).not.toHaveBeenCalled();
    // And the press points at the field to shorten rather than only refusing.
    expect(disclosure.open).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText("Reason"));
  });

  it("negative control: an accepted press leaves the disclosure as the operator left it", () => {
    // Without this, the case above would pass over a control that yanked the
    // disclosure open on every submission, which would be the console overriding the
    // operator's own arrangement rather than answering a refusal.
    const cancel = vi.fn();
    const { container } = render(
      <OperatorControls
        {...RUN_A_ADDRESS}
        cancel={{ kind: "admitted", cancel }}
        resume={{ kind: "refused", refusal: unregisteredRunControl("resume") }}
      />,
    );
    const disclosure = container.querySelector("details");

    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "superseded" } });
    fireEvent.click(screen.getByRole("button", { name: /cancel this run/iu }));

    expect(cancel).toHaveBeenCalledWith("superseded");
    expect(disclosure instanceof HTMLDetailsElement ? disclosure.open : true).toBe(false);
  });

  it("negative control: a reason exactly at the bound travels", () => {
    // Without this, the case above would pass over a component that refused every
    // reason, or that never called through at all.
    const cancel = vi.fn();
    const atBound = "a".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP);
    render(
      <OperatorControls
        {...RUN_A_ADDRESS}
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
        {...RUN_A_ADDRESS}
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
        {...RUN_A_ADDRESS}
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
        {...RUN_A_ADDRESS}
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
        {...RUN_A_ADDRESS}
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
        {...RUN_A_ADDRESS}
        cancel={{ kind: "refused", refusal: unregisteredRunControl("cancel") }}
        resume={{ kind: "admitted", resume: vi.fn(), versionChain: [] }}
      />,
    );
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});

/*
 * THE PANE HOLDING THESE CONTROLS IS RETARGETED IN PLACE. The deck rewrites a pane's
 * address and hands the same component instance another run, so the two fields here —
 * a typed cancellation reason and a chosen re-pin target — have to be answers about
 * the run the controls are now addressed at.
 *
 * The re-pin is the sharper half. A version chain is per run, so run A's chosen id is
 * in run B's chain nowhere: a `<select>` whose value matches no option falls back to
 * DISPLAYING its first one while the state it is bound to still holds run A's id. The
 * operator sees "Keep the pinned version", presses Resume, and the call carries a
 * target they never chose for a run they had not looked at.
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
        growth={RUN_A_ADDRESS.growth}
        workflowRunId={props.workflowRunId}
        cancel={{ kind: "admitted", cancel: vi.fn() }}
        resume={{ kind: "admitted", resume: props.resume, versionChain: props.versionChain }}
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
    // The premise: both fields really did take the operator's answers about run A.
    expect(typedReason()).toBe("superseded");
    expect(chosenRepin()).toBe("wfv-02");
    rendered.rerender(admitted({ workflowRunId: "run-b", versionChain: RUN_B_CHAIN, resume }));
    return rendered;
  }

  it("carries neither the reason nor the re-pin target into the next run", () => {
    fillRunAThenRetarget(vi.fn());
    expect(typedReason()).toBe("");
    expect(chosenRepin()).toBe(NO_REPIN_VALUE);
    // And the line that quotes the target is gone with it, rather than printing run
    // A's version id under run B's address.
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
    // The premise of the case above, asserted rather than assumed: an id the new chain
    // happened to contain would be a legal choice there, and the defect would be a
    // silent one rather than a wrong call.
    expect(RUN_B_CHAIN.map((choice) => choice.workflowVersionId)).not.toContain("wfv-02");
  });

  it("negative control: a re-render at the SAME run keeps both answers", () => {
    // Without this, the cases above would be satisfied by fields that cleared on every
    // render — which would make the reason untypeable and the picker unusable.
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

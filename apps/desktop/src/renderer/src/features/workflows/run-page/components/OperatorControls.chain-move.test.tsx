// The version chain moves under a selection the run never moved away from. Every case holds the
// run still and varies the chain (a version published while the pane stood open, or a resume
// control re-served after a refusal), which run scoping cannot cover. A `<select>` handed a value
// no option carries reports `selectedIndex` -1, so the picker went blank while the held id was
// still spent; the last case asserts that platform behavior.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OperatorControls } from "./OperatorControls.js";
import { IDLE_RUN_CONTROL_OUTCOME, type WorkflowVersionChoice } from "../run-controls.js";

/** The one address every case renders at: the run is what these cases hold still. */
const RUN_ADDRESS = { workflowRunId: "run-a" } as const;

/** The picker's own value for "resume without re-pinning", as the DOM carries it. */
const NO_REPIN_VALUE = "";

/** The chain a person chooses from, before anything is published. */
const CHAIN_BEFORE: readonly WorkflowVersionChoice[] = [
  { workflowVersionId: "wfv-03", label: "Version 3", isCurrentPin: true },
  { workflowVersionId: "wfv-02", label: "Version 2", isCurrentPin: false },
];

/** The same run's chain after a version lands, with the chosen one no longer on it. */
const CHAIN_AFTER: readonly WorkflowVersionChoice[] = [
  { workflowVersionId: "wfv-04", label: "Version 4", isCurrentPin: true },
];

/** The same run's chain after a version lands that still carries the chosen one. */
const CHAIN_AFTER_KEEPING_CHOICE: readonly WorkflowVersionChoice[] = [
  { workflowVersionId: "wfv-04", label: "Version 4", isCurrentPin: true },
  { workflowVersionId: "wfv-02", label: "Version 2", isCurrentPin: false },
];

function admitted(props: {
  readonly versionChain: readonly WorkflowVersionChoice[];
  readonly resume: () => void;
}): React.JSX.Element {
  return (
    <OperatorControls
      {...RUN_ADDRESS}
      cancel={{ cancel: vi.fn(), outcome: IDLE_RUN_CONTROL_OUTCOME }}
      resume={{
        resume: props.resume,
        versionChain: props.versionChain,
        outcome: IDLE_RUN_CONTROL_OUTCOME,
      }}
    />
  );
}

function chosenRepin(): string {
  const picker = screen.getByRole("combobox");
  return picker instanceof HTMLSelectElement ? picker.value : "unreadable";
}

/** Choose `wfv-02` on the chain before, then serve `chain` for the same run. */
function chooseThenMoveChain(
  chain: readonly WorkflowVersionChoice[],
  resume: () => void,
): ReturnType<typeof render> {
  const rendered = render(admitted({ versionChain: CHAIN_BEFORE, resume }));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "wfv-02" } });
  expect(chosenRepin()).toBe("wfv-02");
  rendered.rerender(admitted({ versionChain: chain, resume }));
  return rendered;
}

describe("a chain that moves under a held re-pin target", () => {
  it("offers no target the chain on screen does not carry", () => {
    chooseThenMoveChain(CHAIN_AFTER, vi.fn());

    expect(chosenRepin()).toBe(NO_REPIN_VALUE);
    // The line quoting the target goes with it.
    expect(screen.queryByText(/resuming onto/iu)).toBeNull();
  });

  it("resumes with no target rather than one that left the chain", () => {
    const resume = vi.fn();
    chooseThenMoveChain(CHAIN_AFTER, resume);
    fireEvent.click(screen.getByRole("button", { name: /resume this run/iu }));

    expect(resume).toHaveBeenCalledWith(undefined);
    expect(resume).not.toHaveBeenCalledWith({ targetWorkflowVersionId: "wfv-02" });
  });

  it("negative control: a chain that still carries the choice keeps it", () => {
    // Without this, the two cases above would pass over a component that dropped the target on
    // every chain change, discarding a person's choice whenever an unrelated version landed.
    const resume = vi.fn();
    chooseThenMoveChain(CHAIN_AFTER_KEEPING_CHOICE, resume);

    expect(chosenRepin()).toBe("wfv-02");
    fireEvent.click(screen.getByRole("button", { name: /resume this run/iu }));
    expect(resume).toHaveBeenCalledWith({ targetWorkflowVersionId: "wfv-02" });
  });

  it("negative control: a picker handed an unofferable value shows nothing at all", () => {
    // The platform premise, asserted rather than assumed.
    const picker = document.createElement("select");
    for (const choice of CHAIN_AFTER) {
      const option = document.createElement("option");
      option.value = choice.workflowVersionId;
      picker.append(option);
    }
    picker.value = "wfv-02";

    expect(picker.selectedIndex).toBe(-1);
    expect(picker.value).toBe(NO_REPIN_VALUE);
  });
});

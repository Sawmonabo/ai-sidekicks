// That the candidate list offers what the walk read, and says so when it did not finish.
//
// The negative control that makes the empty claim mean anything: a walk the page cap
// cut short answers no question about what is missing, so "nothing matches" is
// withheld under it.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkflowStartCandidates } from "./WorkflowStartCandidates.js";
import { workflowDefinition } from "./workflow-start.test-support.js";

const DEFINITIONS = [
  workflowDefinition({ name: "nightly" }),
  workflowDefinition({ name: "release" }),
];

/** The names the candidate list is offering. */
function candidateNames(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-workflow-start__candidate-name")].map(
    (element) => element.textContent ?? "",
  );
}

describe("WorkflowStartCandidates", () => {
  it("narrows what it offers to the typed prefix", () => {
    const { container, rerender } = render(
      <WorkflowStartCandidates
        definitions={DEFINITIONS}
        complete
        typedPrefix={undefined}
        onComplete={vi.fn()}
      />,
    );
    expect(candidateNames(container)).toStrictEqual(["nightly", "release"]);

    rerender(
      <WorkflowStartCandidates
        definitions={DEFINITIONS}
        complete
        typedPrefix="rel"
        onComplete={vi.fn()}
      />,
    );

    expect(candidateNames(container)).toStrictEqual(["release"]);
  });

  it("completes the line with the definition a person picks", () => {
    const onComplete = vi.fn();
    const { container } = render(
      <WorkflowStartCandidates
        definitions={DEFINITIONS}
        complete
        typedPrefix="ni"
        onComplete={onComplete}
      />,
    );

    fireEvent.click(container.querySelector(".meridian-workflow-start__candidate-name")!);

    expect(onComplete).toHaveBeenCalledExactlyOnceWith("nightly");
  });

  it("names the empty result once the walk did finish", () => {
    const { container } = render(
      <WorkflowStartCandidates
        definitions={DEFINITIONS}
        complete
        typedPrefix="zzz-nothing-is-named-this"
        onComplete={vi.fn()}
      />,
    );

    expect(container.textContent).toContain("No workflow this session can start matches");
  });

  it("says the search did not finish rather than claiming nothing matches", () => {
    const { container } = render(
      <WorkflowStartCandidates
        definitions={DEFINITIONS}
        complete={false}
        typedPrefix="zzz-nothing-is-named-this"
        onComplete={vi.fn()}
      />,
    );

    expect(container.textContent).not.toContain("No workflow this session can start matches");
  });
});

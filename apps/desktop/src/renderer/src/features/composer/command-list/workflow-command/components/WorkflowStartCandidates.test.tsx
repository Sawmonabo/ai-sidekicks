// What picking a candidate does and what the list says when it has nothing to offer. A walk the
// page cap cut short withholds "nothing matches", which is the control for the empty claim.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkflowStartCandidates } from "./WorkflowStartCandidates.js";
import { workflowDefinition } from "../workflow-command.test-support.js";

const DEFINITIONS = [
  workflowDefinition({ name: "nightly" }),
  workflowDefinition({ name: "release" }),
];

describe("WorkflowStartCandidates", () => {
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

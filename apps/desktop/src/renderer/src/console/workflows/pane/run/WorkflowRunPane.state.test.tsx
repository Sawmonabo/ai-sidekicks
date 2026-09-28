// What the pane stands on for each address it is given.
//
// The pane tests assert the KIND modifiers and the mounted regions rather than the
// sentences, because the copy is this family's to reword and what the arms owe is a rule:
// an empty pane offers the start affordance, and an addressed run draws its summary line
// with no absence and no competing start.

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ADDRESSED_RUN, paneContext, renderPane } from "./WorkflowRunPane.test-support.js";

afterEach(() => {
  cleanup();
});

describe("workflow run pane — the arms and what each offers", () => {
  it("reports an unaddressed pane as empty and offers the start affordance there", () => {
    const section = renderPane(paneContext(undefined));
    expect(section.querySelector(".meridian-nothing--empty")).not.toBeNull();
    // One slot, and it is the conversational start: an empty pane offers the start
    // affordance, which is the empty state as designed rather than a fallback.
    expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(1);
  });

  it("offers no start affordance beside a run it already names", () => {
    // Negative control for the case above: both would pass over a pane that mounted the
    // same regions on every arm, and a second entry point would compete with the run in
    // front of the operator.
    const section = renderPane(paneContext(ADDRESSED_RUN));
    expect(section.querySelector(".meridian-workflow__summary")?.textContent ?? "").toContain(
      "One run's state",
    );
    expect(section.querySelector(".meridian-nothing")).toBeNull();
    expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(0);
  });
});

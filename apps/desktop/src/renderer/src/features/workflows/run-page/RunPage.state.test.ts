// What the pane stands on for each address. It asserts the kind modifiers and mounted regions,
// not the sentences, so the copy stays free to be reworded.

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ADDRESSED_RUN, paneContext, renderRunPage } from "./RunPage.test-support.js";

afterEach(() => {
  cleanup();
});

describe("workflow run pane — the arms and what each offers", () => {
  it("reports an unaddressed pane as empty and offers the start affordance there", () => {
    const section = renderRunPage(paneContext(undefined));
    expect(section.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(section.querySelectorAll(".meridian-workflow__mount-point")).toHaveLength(1);
  });

  it("offers no start affordance beside a run it already names", () => {
    // Negative control: both cases would pass over a pane that mounted the same regions on every
    // arm, and a second entry point would compete with the run in front of the operator.
    const section = renderRunPage(paneContext(ADDRESSED_RUN));
    expect(section.querySelector(".meridian-workflow__summary")?.textContent ?? "").toContain(
      "One run's state",
    );
    expect(section.querySelector(".meridian-nothing")).toBeNull();
    expect(section.querySelectorAll(".meridian-workflow__mount-point")).toHaveLength(0);
  });
});

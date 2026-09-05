// The awaiting-projection sentence bounds its enumeration and never its count.
//
// Driven against the component rather than through the pane, because the claim is
// about one paragraph: which ids it names, and what it says about the runs it does
// not name. The seating that produces the two numbers is asserted next door in
// `run-seating.test.ts`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AwaitingProjection } from "./AwaitingProjection.js";
import { AWAITING_RUN_IDS_NAMED_CAP } from "./runs-bounds.js";

/** As many distinct run ids as the case needs, in the order the seating hands them. */
function runIds(count: number): readonly string[] {
  return Array.from({ length: count }, (_unused, index) => `run-${String(index).padStart(4, "0")}`);
}

describe("the ids are an enumeration and the figure is a reading", () => {
  it("names the ids up to the cap and folds the rest into the count", () => {
    const overflow = 4;
    const { container } = render(
      <AwaitingProjection
        runIds={runIds(AWAITING_RUN_IDS_NAMED_CAP + overflow)}
        withheldCount={0}
      />,
    );
    const text = container.textContent ?? "";

    expect(container.querySelectorAll(".meridian-figure--wire")).toHaveLength(
      AWAITING_RUN_IDS_NAMED_CAP,
    );
    expect(text).toContain(`and ${String(overflow)} more`);
    // The count is of every run the stream has not described, not of the ids drawn.
    expect(text).toContain(`described ${String(AWAITING_RUN_IDS_NAMED_CAP + overflow)} runs`);
  });

  it("counts the runs the seating cap kept off the pane in the same figure", () => {
    const { container } = render(<AwaitingProjection runIds={runIds(2)} withheldCount={7} />);
    const text = container.textContent ?? "";

    // Nine runs are undescribed; two have a row. A sentence reporting two would take
    // a bounded pane for a complete one.
    expect(text).toContain("described 9 runs");
    expect(text).toContain("have no row on this pane");
  });

  it("negative control: a short list names every id and claims nothing is withheld", () => {
    // Without this the cases above would pass over a component that always truncated
    // and always claimed rows were missing.
    const { container } = render(<AwaitingProjection runIds={runIds(2)} withheldCount={0} />);
    const text = container.textContent ?? "";

    expect(container.querySelectorAll(".meridian-figure--wire")).toHaveLength(2);
    expect(text).not.toContain("more");
    expect(text).not.toContain("no row on this pane");
  });
});

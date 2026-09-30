// A row that throws names its failure instead of leaving a gap, and does not blank the log
// around it.

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { windowTripwires } from "@renderer/lib/tripwires.js";
import { TranscriptRowGroup } from "./TranscriptRowGroup.js";

describe("a row group that fails to project", () => {
  let restoreThrowOnReport = false;

  beforeEach(() => {
    // The registry throws in a development build, and the boundary reports from
    // `componentDidCatch`: a second failure inside React's own error handling.
    restoreThrowOnReport = import.meta.env.DEV;
    windowTripwires.setThrowOnReport(false);
    windowTripwires.reset();
  });

  afterEach(() => {
    windowTripwires.setThrowOnReport(restoreThrowOnReport);
    windowTripwires.reset();
  });

  it("renders red, names the failure, and offers the one move there is", () => {
    function UnreadableRow(): React.JSX.Element {
      throw new Error("the projection had no body for this entry");
    }
    const { container } = render(
      <TranscriptRowGroup groupLabel="This entry">
        <UnreadableRow />
      </TranscriptRowGroup>,
    );
    expect(container.querySelectorAll(".meridian-transcript-row-failure")).toHaveLength(1);
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/the projection had no body for this entry/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
  });
});

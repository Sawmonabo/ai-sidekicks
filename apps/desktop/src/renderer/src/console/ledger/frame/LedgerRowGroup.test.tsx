// A row that names its own failure, instead of leaving a gap in the log.
//
// The subject is the boundary and nothing else: a single row that throws must not
// blank the log around it, and what stands in its place has to say WHY rather than
// being an empty band a reader scrolls past as an entry with nothing in it.

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { consoleTripwires } from "../../core/tripwires.js";
import { LedgerRowGroup } from "./LedgerRowGroup.js";

describe("a row group that fails to project", () => {
  let restoreThrowOnReport = false;

  beforeEach(() => {
    // The registry throws in a development build, and the boundary reports from
    // `componentDidCatch` — a second failure inside React's own error handling.
    restoreThrowOnReport = import.meta.env.DEV;
    consoleTripwires.setThrowOnReport(false);
    consoleTripwires.reset();
  });

  afterEach(() => {
    consoleTripwires.setThrowOnReport(restoreThrowOnReport);
    consoleTripwires.reset();
  });

  it("renders red, names the failure, and offers the one move there is", () => {
    function UnreadableRow(): React.JSX.Element {
      throw new Error("the projection had no body for this entry");
    }
    const { container } = render(
      <LedgerRowGroup groupLabel="This entry">
        <UnreadableRow />
      </LedgerRowGroup>,
    );
    expect(container.querySelectorAll(".meridian-ledger-row-failure")).toHaveLength(1);
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/the projection had no body for this entry/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
  });

  it("negative control: a row that renders is left alone", () => {
    const { container } = render(
      <LedgerRowGroup groupLabel="This entry">
        <p>the entry rendered</p>
      </LedgerRowGroup>,
    );
    expect(container.querySelectorAll(".meridian-ledger-row-failure")).toHaveLength(0);
    expect(screen.getByText("the entry rendered")).toBeDefined();
  });
});

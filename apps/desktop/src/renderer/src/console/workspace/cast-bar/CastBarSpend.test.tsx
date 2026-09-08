// The spend figure's one cost claim: it is formatted once per figure, not per paint.
//
// WHY THIS IS WORTH A SUITE. `formatCentsAsCurrency` reaches `Intl.NumberFormat`
// through `formatMoney`, which builds a fresh instance per call and reads the
// currency's minor-unit digits to size its own fraction bounds. The cast bar sits
// above the whole console and repaints on every reading any of its parts subscribes
// to, and none of those readings move the committed spend — so an unmemoized figure
// is one `Intl` construction per bar paint for a number that did not change.
//
// The real formatter is spied rather than replaced (`{ spy: true }` keeps the
// implementation), so the rendered string in each case below is the true one and the
// count is a claim about how often it was produced.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { formatCentsAsCurrency } from "../../primitives/index.js";
import { CastBarSpend } from "./CastBarSpend.js";
import { type CastBarSpendReading } from "./cast-bar-readings.js";
import { type CastBarReadState } from "./cast-bar-reads.js";

vi.mock(import("../../primitives/wire-figures.js"), { spy: true });

function served(
  committedSpendCents: number,
  costStatus = "priced",
): CastBarReadState<CastBarSpendReading> {
  return { status: "served", value: { committedSpendCents, costStatus } };
}

describe("CastBarSpend — the committed figure is formatted once per figure", () => {
  it("formats one total once, however many times the bar repaints", () => {
    const formatter = vi.mocked(formatCentsAsCurrency);
    formatter.mockClear();

    const { rerender, container } = render(<CastBarSpend spend={served(123_45)} />);
    expect(formatter).toHaveBeenCalledTimes(1);
    const figure = container.querySelector(".meridian-cast-bar__spend .meridian-figure");
    expect(figure?.getAttribute("title")).toBe("12345 cents committed");

    // Two more paints carrying the same total. The qualifier moves on the second so
    // the re-renders are visible in the tree rather than only asserted.
    rerender(<CastBarSpend spend={served(123_45)} />);
    rerender(<CastBarSpend spend={served(123_45, "partially-priced")} />);
    expect(container.querySelector(".meridian-cast-bar__spend-qualifier")?.textContent).toBe(
      "at least",
    );
    expect(formatter).toHaveBeenCalledTimes(1);

    // ...and the memo is keyed on the figure rather than frozen at mount, so a
    // receipt that moves the total is re-read rather than showing the old one.
    rerender(<CastBarSpend spend={served(200_00)} />);
    expect(formatter).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".meridian-cast-bar__spend .meridian-figure")?.textContent).toBe(
      formatter.mock.results[1]?.value,
    );
  });

  it("formats nothing at all while the read has served no figure", () => {
    const formatter = vi.mocked(formatCentsAsCurrency);
    formatter.mockClear();

    // The memo sits above the unsettled arm because a hook cannot sit behind a
    // return — which must not turn into formatting a figure the bar does not have.
    const { container } = render(<CastBarSpend spend={{ status: "reading" }} />);
    expect(formatter).not.toHaveBeenCalled();
    expect(container.querySelector(".meridian-cast-bar__spend")).toBeNull();
  });
});

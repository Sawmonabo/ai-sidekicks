// Three absences, and the one that carries an act.
//
// The arms are ordered — a refusal beats an unread list beats an empty one — and the
// order is the claim: a session whose run stream never opened has no standing to say
// "no run has started". The other claim is the affordance's placement, which is the
// half an empty state usually gets wrong: the control belongs on the arm whose
// sentence names the act and nowhere else, because neither of the other two says a
// run could be started right now.
//
// The offer itself is `run-start-offer.test.tsx`'s subject, which drives this
// component and the palette contribution over one reading; what is asserted here is
// that this component renders the arm the reading names.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { refuse } from "../../core/index.js";
import { NoRuns } from "./NoRuns.js";
import { type RunStartOfferReading } from "./run-start-offer.js";

const STREAM_REFUSED = refuse("runs-state", "session.not_found", "That session is not here.");

/** The reading the body hands down when the seating produced no row at all. */
function reading(overrides: Partial<RunStartOfferReading> = {}): RunStartOfferReading {
  return { seatedRunCount: 0, hasRead: true, openRefusal: undefined, ...overrides };
}

describe("which absence the pane shows", () => {
  it("shows the stream's refusal ahead of either absence", () => {
    render(<NoRuns reading={reading({ openRefusal: STREAM_REFUSED })} onStart={vi.fn()} />);

    expect(screen.getByText("session.not_found")).not.toBeNull();
    expect(screen.queryByText("No run has started in this session yet.")).toBeNull();
  });

  it("says the read has not landed while it has not", () => {
    render(<NoRuns reading={reading({ hasRead: false })} onStart={vi.fn()} />);

    expect(screen.getByText("Reading the runs in this session.")).not.toBeNull();
  });

  it("says there are none only once the read has landed", () => {
    render(<NoRuns reading={reading()} onStart={vi.fn()} />);

    expect(screen.getByText("No run has started in this session yet.")).not.toBeNull();
  });
});

describe("the act the empty arm names", () => {
  it("offers the control, and asks for the caret when it is pressed", () => {
    const onStart = vi.fn();
    render(<NoRuns reading={reading()} onStart={onStart} />);

    screen.getByRole("button", { name: "Write a message" }).click();

    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("offers nothing while the read has not landed", () => {
    // Negative control, and the placement rule: a surface still reading cannot say a
    // run could be started, so it offers no control that says one could.
    render(<NoRuns reading={reading({ hasRead: false })} onStart={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Write a message" })).toBeNull();
  });

  it("offers nothing when the stream refused", () => {
    render(<NoRuns reading={reading({ openRefusal: STREAM_REFUSED })} onStart={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Write a message" })).toBeNull();
  });

  it("offers nothing once a run has been seated, even on the empty sentence", () => {
    // The seating is the third conjunct, and it is the one this component cannot see
    // for itself: it is mounted only where there are no rows, so a component deciding
    // its own offer would answer "yes" for a reading that says a run is on screen.
    render(<NoRuns reading={reading({ seatedRunCount: 1 })} onStart={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Write a message" })).toBeNull();
  });
});

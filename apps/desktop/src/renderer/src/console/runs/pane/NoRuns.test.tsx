// Three absences, and the one that carries an act.
//
// The arms are ordered — a refusal beats an unread list beats an empty one — and the
// order is the claim: a session whose run stream never opened has no standing to say
// "no run has started". The other claim is the affordance's placement, which is the
// half an empty state usually gets wrong: the control belongs on the arm whose
// sentence names the act and nowhere else, because neither of the other two says a
// run could be started right now.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { refuse } from "../../core/index.js";
import { NoRuns } from "./NoRuns.js";

const STREAM_REFUSED = refuse("runs-state", "session.not_found", "That session is not here.");

describe("which absence the pane shows", () => {
  it("shows the stream's refusal ahead of either absence", () => {
    render(<NoRuns hasRead openRefusal={STREAM_REFUSED} onStart={vi.fn()} />);

    expect(screen.getByText("session.not_found")).not.toBeNull();
    expect(screen.queryByText("No run has started in this session yet.")).toBeNull();
  });

  it("says the read has not landed while it has not", () => {
    render(<NoRuns hasRead={false} openRefusal={undefined} onStart={vi.fn()} />);

    expect(screen.getByText("Reading the runs in this session.")).not.toBeNull();
  });

  it("says there are none only once the read has landed", () => {
    render(<NoRuns hasRead openRefusal={undefined} onStart={vi.fn()} />);

    expect(screen.getByText("No run has started in this session yet.")).not.toBeNull();
  });
});

describe("the act the empty arm names", () => {
  it("offers the control, and asks for the caret when it is pressed", () => {
    const onStart = vi.fn();
    render(<NoRuns hasRead openRefusal={undefined} onStart={onStart} />);

    screen.getByRole("button", { name: "Write a message" }).click();

    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("offers nothing while the read has not landed", () => {
    // Negative control, and the placement rule: a surface still reading cannot say a
    // run could be started, so it offers no control that says one could.
    render(<NoRuns hasRead={false} openRefusal={undefined} onStart={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Write a message" })).toBeNull();
  });

  it("offers nothing when the stream refused", () => {
    render(<NoRuns hasRead openRefusal={STREAM_REFUSED} onStart={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Write a message" })).toBeNull();
  });
});

// The window's absences, mounted — and the region they must not create.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WindowAbsences } from "./WindowAbsences.js";
import { type WindowAbsence } from "./window-absence.js";

const SUBJECT = "entries";

function renderAbsences(...absences: readonly WindowAbsence[]): HTMLElement {
  const { container } = render(<WindowAbsences absences={absences} subject={SUBJECT} />);
  return container;
}

describe("WindowAbsences — one absence per way the window is short", () => {
  it("renders nothing when the window is the whole of it", () => {
    expect(renderAbsences().innerHTML).toBe("");
    expect(renderAbsences({ kind: "dropped", count: 0 }).innerHTML).toBe("");
  });

  it("mounts one absence per thing there is to say", () => {
    const container = renderAbsences(
      { kind: "dropped", count: 12 },
      { kind: "withheld-by-replay", count: 3 },
      { kind: "never-received" },
    );
    expect(container.querySelectorAll(".meridian-nothing").length).toBe(3);
  });

  it("carries each absence's second line, which the badge shape would drop", () => {
    // `surface` and not `inline`: a badge has no room for a second line and carries
    // it as a tooltip, and every sentence here has one that matters.
    const container = renderAbsences({ kind: "dropped", count: 12 });
    expect(container.querySelector(".meridian-nothing--block")).not.toBeNull();
    expect(container.textContent).toContain("left the window as the session grew");
  });

  it("negative control: the absence scan reads the real tree", () => {
    // Without this the emptiness above would be true of any component whatsoever.
    expect(renderAbsences({ kind: "never-received" }).innerHTML).toContain("meridian-nothing");
  });

  it("creates no live region at all", () => {
    // The console has one announcer; a wrapper of this component's own would be a
    // second speaker. None of the four absence kinds this vocabulary takes carries a
    // region either, which is what makes the claim checkable rather than plausible:
    // these are settled facts about a window, not a read landing under somebody's
    // eyes.
    const container = renderAbsences(
      { kind: "unprojectable", count: 2 },
      { kind: "dropped", count: 2 },
      { kind: "withheld-by-replay", count: 2 },
      { kind: "never-received" },
    );
    expect(container.querySelectorAll('[role="status"], [role="alert"], [aria-live]').length).toBe(
      0,
    );
    expect(container.querySelectorAll(".meridian-nothing").length).toBe(4);
  });
});

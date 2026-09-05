// The window's absences, mounted — and the region they must not create.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WindowAbsences } from "./WindowAbsences.js";
import {
  WINDOW_ABSENCE_KINDS,
  type WindowAbsence,
  type WindowAbsenceKind,
} from "./window-absence.js";

const SUBJECT = "entries";

/** One absence of every kind, so the cases below are driven by the set and not a list. */
const ABSENCE_BY_KIND: Readonly<Record<WindowAbsenceKind, WindowAbsence>> = {
  unprojectable: { kind: "unprojectable", count: 2 },
  dropped: { kind: "dropped", count: 2 },
  "withheld-by-replay": { kind: "withheld-by-replay", count: 2 },
  "never-received": { kind: "never-received" },
  "duplicate-key": { kind: "duplicate-key", count: 2 },
  "past-element-ceiling": { kind: "past-element-ceiling", count: 2 },
};

/** Every kind, as one absence each. */
const EVERY_ABSENCE: readonly WindowAbsence[] = WINDOW_ABSENCE_KINDS.map(
  (kind) => ABSENCE_BY_KIND[kind],
);

/**
 * A phrase from each kind's own title, so "every kind renders" is a claim about which
 * sentence reached the screen rather than about how many boxes did.
 *
 * Written out here rather than read back from `windowAbsenceNotice`: a fixture that
 * asked the model what it says and then asserted the model says it would pass over a
 * table that answered one sentence for every kind.
 */
const TITLE_PHRASE_BY_KIND: Readonly<Record<WindowAbsenceKind, string>> = {
  unprojectable: "could not be placed",
  dropped: "no longer in this window",
  "withheld-by-replay": "behind the replay position",
  "never-received": "never arrived",
  "duplicate-key": "share an identifier",
  "past-element-ceiling": "past what this window can draw",
};

function renderAbsences(...absences: readonly WindowAbsence[]): HTMLElement {
  const { container } = render(<WindowAbsences absences={absences} subject={SUBJECT} />);
  return container;
}

describe("WindowAbsences — one absence per way the window is short", () => {
  it("renders nothing when the window is the whole of it", () => {
    expect(renderAbsences().innerHTML).toBe("");
    expect(renderAbsences({ kind: "dropped", count: 0 }).innerHTML).toBe("");
  });

  it("mounts every kind the vocabulary takes, so none is unrenderable", () => {
    // Driven from the set: an arm added to the vocabulary and not reachable through
    // this mount is a sentence written for a surface that can never show it.
    const container = renderAbsences(...EVERY_ABSENCE);
    expect(container.querySelectorAll(".meridian-nothing").length).toBe(
      WINDOW_ABSENCE_KINDS.length,
    );
    for (const kind of WINDOW_ABSENCE_KINDS) {
      expect(container.textContent, kind).toContain(TITLE_PHRASE_BY_KIND[kind]);
    }
    expect(new Set(Object.values(TITLE_PHRASE_BY_KIND)).size).toBe(WINDOW_ABSENCE_KINDS.length);
  });

  it("negative control: an unknown arm is unrepresentable rather than unrendered", () => {
    // The set is closed at the type level, which is what makes the count above a claim
    // about the vocabulary rather than about this fixture. A `@ts-expect-error` that
    // stopped erroring would fail this file at compile time under TS2578.
    // @ts-expect-error -- "shrunk-by-filter" names no member of the closed set.
    const invented: WindowAbsence = { kind: "shrunk-by-filter", count: 1 };
    expect((WINDOW_ABSENCE_KINDS as readonly string[]).includes(invented.kind)).toBe(false);
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
    // second speaker. No absence kind this vocabulary takes carries a region either,
    // which is what makes the claim checkable rather than plausible: these are settled
    // facts about a window, not a read landing under somebody's eyes.
    const container = renderAbsences(...EVERY_ABSENCE);
    expect(container.querySelectorAll('[role="status"], [role="alert"], [aria-live]').length).toBe(
      0,
    );
    expect(container.querySelectorAll(".meridian-nothing").length).toBe(
      WINDOW_ABSENCE_KINDS.length,
    );
  });
});

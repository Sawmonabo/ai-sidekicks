// The preview card's grace, driven on a frozen clock.
//
// Its own file beside `ProvenanceRail.test.tsx` because the subject is a TIMER rather
// than a rendering: what these cases assert is that exactly one grace is ever armed,
// that it is armed on the injected clock and never on the wall, and that an empty rail
// arms none. Both suites mount the same rail through
// `ProvenanceRail.test-support.tsx`.

import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "../../../core/index.js";
import { RAIL_PREVIEW_GRACE_MS } from "../structure-bounds.js";
import { emptyRail, renderRail } from "./ProvenanceRail.test-support.js";

describe("rail — the preview opens after a grace, measured on the injected clock", () => {
  it("opens no card before the grace has elapsed", () => {
    const clock = new ManualClock();
    const { slider } = renderRail({ clock });
    fireEvent.pointerMove(slider, { clientY: 0 });
    act(() => {
      clock.advance(RAIL_PREVIEW_GRACE_MS - 1);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("opens the card the pointer was over once the grace elapses", () => {
    const clock = new ManualClock();
    const { slider } = renderRail({ clock });
    fireEvent.pointerMove(slider, { clientY: 0 });
    act(() => {
      clock.advance(RAIL_PREVIEW_GRACE_MS);
    });
    expect(screen.getByRole("status").textContent).toContain("asked for the deploy plan");
  });

  it("reads no wall clock: with the frozen clock never advanced, no card ever opens", () => {
    // Which is the whole reason the grace takes a `ConsoleClock`. A rail that
    // reached past it to `setTimeout` would open this card on its own, and the
    // armed count is what says one grace — not none, and not one per tick — is
    // waiting.
    const clock = new ManualClock();
    const { slider } = renderRail({ clock });
    fireEvent.pointerMove(slider, { clientY: 0 });
    fireEvent.pointerMove(slider, { clientY: 0 });
    fireEvent.pointerMove(slider, { clientY: 0 });
    expect(screen.queryByRole("status")).toBeNull();
    expect(clock.pendingCount).toBe(1);
  });

  it("negative control: a rail with no marks arms no grace at all", () => {
    // `tickNearest` answers `undefined` over an empty rail, and the grace shows
    // the absence immediately rather than scheduling a card with nothing in it.
    const clock = new ManualClock();
    const { slider } = renderRail({ clock, model: emptyRail() });
    fireEvent.pointerMove(slider, { clientY: 0 });
    expect(clock.pendingCount).toBe(0);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

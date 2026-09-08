// Which grid track the ledger's scroll surface lands in, and whether that depends on
// how many of its siblings happen to be rendering.
//
// THE RULE. `ledger/frame/frame.css` gives `.meridian-ledger-viewport` two tracks,
// `auto minmax(0, 1fr)`, written for an error slot above a scroll surface. But
// `LedgerErrorSlot` returns `null` with no entries, and the head and tail affordances
// are both `position: absolute` and out of flow — so in the ordinary case the surface
// is the ONLY in-flow child and auto-places into track 1, the `auto` one. The `1fr`
// track it was written for sits empty below it and absorbs every pixel of free space,
// which leaves the scroll container sized by its content instead of by its box.
//
// WHY THAT IS NOT MERELY UNTIDY. The surface is what the virtualizer ranges against.
// A content-sized scroll container has no overflow to speak of, so the window computes
// its range against a height that has nothing to do with the pane — and at the limit,
// a first commit with no rows, content height is zero, `calculateRange` returns `null`
// for `outerSize === 0`, and nothing ever mounts to grow it back. Placement that
// depends on a sibling rendering is placement that changes with an unrelated error.
//
// A CSS RULE, TESTED AS ONE. These cases assert the sheet and not a composition: they
// render the two class names the sheet is about, under the real stylesheet, in the two
// child arrangements that actually ship — one in-flow child and two. That is the whole
// of what the rule decides. It deliberately does NOT stand in for the pane-level
// measurement `deck-pane-fill.test.tsx` makes; the two are different levels of the same
// chain and each has its own case.

import { describe, expect, it } from "vitest";

import { renderSettled } from "../console-harness.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
// The ledger frame's door, imported for its side effect: the family's stylesheet lives
// behind its own barrel and this tier is about what that stylesheet computes to.
import "../../../src/renderer/src/console/ledger/frame/index.js";

/** The box the viewport is given. Every assertion below is against this number. */
const VIEWPORT_BOX_HEIGHT_PX = 600;

/** What an error slot occupies when it renders, so the two-child case can subtract it. */
const ERROR_SLOT_HEIGHT_PX = 40;

async function mountViewportSurface(withErrorSlot: boolean): Promise<HTMLElement> {
  installMeridianTokens(document);
  const { container } = await renderSettled(
    <div style={{ display: "grid", height: `${String(VIEWPORT_BOX_HEIGHT_PX)}px` }}>
      <div className="meridian-ledger-viewport">
        {withErrorSlot ? <div style={{ height: `${String(ERROR_SLOT_HEIGHT_PX)}px` }} /> : null}
        <div className="meridian-ledger-viewport__surface" />
      </div>
    </div>,
  );
  const surface = container.querySelector(".meridian-ledger-viewport__surface");
  if (!(surface instanceof HTMLElement)) {
    throw new Error("the viewport surface did not mount");
  }
  return surface;
}

describe("browser — the ledger's scroll surface takes the viewport's height", () => {
  it("fills the box when it is the only child in flow, which is the ordinary case", async () => {
    const surface = await mountViewportSurface(false);

    expect(
      surface.getBoundingClientRect().height,
      "the scroll surface is sized by its content rather than by the viewport, so the window is ranging against a height the pane never gave it",
    ).toBe(VIEWPORT_BOX_HEIGHT_PX);
  });

  it("still leaves the error slot its own height when one renders", async () => {
    // The control that keeps the rule from being "the surface is always the whole
    // box": an error slot above it is exactly what the two-track template was written
    // for, and a surface that covered it would hide the row failures it announces.
    const surface = await mountViewportSurface(true);

    expect(surface.getBoundingClientRect().height).toBe(
      VIEWPORT_BOX_HEIGHT_PX - ERROR_SLOT_HEIGHT_PX,
    );
  });

  it("negative control: a viewport with no height of its own gives the surface none", async () => {
    // Without this the cases above would pass over a surface handed a fixed height,
    // and the claim is the opposite one — the surface takes what the viewport HAS.
    installMeridianTokens(document);
    const { container } = await renderSettled(
      <div style={{ display: "grid" }}>
        <div className="meridian-ledger-viewport">
          <div className="meridian-ledger-viewport__surface" />
        </div>
      </div>,
    );
    const surface = container.querySelector(".meridian-ledger-viewport__surface");
    if (!(surface instanceof HTMLElement)) {
      throw new Error("the viewport surface did not mount");
    }

    expect(surface.getBoundingClientRect().height).toBe(0);
  });
});

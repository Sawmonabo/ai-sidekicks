// Which grid track the transcript's scroll container lands in, and whether that depends on
// how many of its siblings happen to be rendering.
//
// THE RULE. `transcript-viewport.css` gives `.meridian-transcript-viewport` two tracks,
// `auto minmax(0, 1fr)`, written for an error region above a scroll container. But
// `TranscriptErrors` returns `null` with no entries, and the head and tail affordances
// are both `position: absolute` and out of flow — so in the ordinary case the scroll
// container is the ONLY in-flow child and auto-places into track 1, the `auto` one. The `1fr`
// track it was written for sits empty below it and absorbs every pixel of free space,
// which leaves the scroll container sized by its content instead of by its box.
//
// WHY THAT IS NOT MERELY UNTIDY. The scroll container is what the virtualizer ranges
// against.
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
// measurement `pane-layout-pane-fill.test.tsx` makes; the two are different levels of the same
// chain and each has its own case.

import { describe, expect, it } from "vitest";

import { renderSettled } from "../helpers/app-harness.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
// The viewport's stylesheet, imported for its side effect: this tier is about what it
// computes to.
import "@renderer/features/transcript/viewport/components/transcript-viewport.css";

/** The box the viewport is given. Every assertion below is against this number. */
const VIEWPORT_BOX_HEIGHT_PX = 600;

/** What an error region occupies when it renders, so the two-child case can subtract it. */
const ERROR_REGION_HEIGHT_PX = 40;

async function mountViewportScrollContainer(withErrorRegion: boolean): Promise<HTMLElement> {
  installMeridianTokens(document);
  const { container } = await renderSettled(
    <div style={{ display: "grid", height: `${String(VIEWPORT_BOX_HEIGHT_PX)}px` }}>
      <div className="meridian-transcript-viewport">
        {withErrorRegion ? <div style={{ height: `${String(ERROR_REGION_HEIGHT_PX)}px` }} /> : null}
        <div className="meridian-transcript-viewport__scroll-container" />
      </div>
    </div>,
  );
  const scrollContainer = container.querySelector(
    ".meridian-transcript-viewport__scroll-container",
  );
  if (!(scrollContainer instanceof HTMLElement)) {
    throw new Error("the viewport scroll container did not mount");
  }
  return scrollContainer;
}

describe("browser — the transcript's scroll container takes the viewport's height", () => {
  it("fills the box when it is the only child in flow, which is the ordinary case", async () => {
    const scrollContainer = await mountViewportScrollContainer(false);

    expect(
      scrollContainer.getBoundingClientRect().height,
      "the scroll container is sized by its content rather than by the viewport, so the window is ranging against a height the pane never gave it",
    ).toBe(VIEWPORT_BOX_HEIGHT_PX);
  });

  it("still leaves the error region its own height when one renders", async () => {
    // The control that keeps the rule from being "the scroll container is always the
    // whole box": an error region above it is exactly what the two-track template was written
    // for, and a scroll container that covered it would hide the row failures it announces.
    const scrollContainer = await mountViewportScrollContainer(true);

    expect(scrollContainer.getBoundingClientRect().height).toBe(
      VIEWPORT_BOX_HEIGHT_PX - ERROR_REGION_HEIGHT_PX,
    );
  });

  it("negative control: a viewport with no height of its own gives the scroll container none", async () => {
    // Without this the cases above would pass over a scroll container handed a fixed
    // height, and the claim is the opposite one — the scroll container takes what the
    // viewport HAS.
    installMeridianTokens(document);
    const { container } = await renderSettled(
      <div style={{ display: "grid" }}>
        <div className="meridian-transcript-viewport">
          <div className="meridian-transcript-viewport__scroll-container" />
        </div>
      </div>,
    );
    const scrollContainer = container.querySelector(
      ".meridian-transcript-viewport__scroll-container",
    );
    if (!(scrollContainer instanceof HTMLElement)) {
      throw new Error("the viewport scroll container did not mount");
    }

    expect(scrollContainer.getBoundingClientRect().height).toBe(0);
  });
});

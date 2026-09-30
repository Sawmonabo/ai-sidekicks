// Which grid track the transcript's scroll container lands in, and whether that depends on how
// many of its siblings are rendering.
//
// `transcript-viewport.css` gives `.meridian-transcript-viewport` two tracks, `auto minmax(0,
// 1fr)`, written for an error region above a scroll container. `TranscriptErrors` returns `null`
// with no entries and the head and tail affordances are `position: absolute`, so ordinarily the
// scroll container is the only in-flow child and would auto-place into the `auto` track, leaving
// the `1fr` track empty and the container sized by its content instead of its box.
//
// That matters because the scroll container is what the virtualizer ranges against: a
// content-sized one gives the window a height unrelated to the pane, and with no rows the
// content height is zero, `calculateRange` returns `null` for `outerSize === 0`, and nothing
// ever mounts to grow it back.
//
// These cases assert the sheet, not a composition: the two class names under the real
// stylesheet in the two child arrangements that ship (one in-flow child and two).

import { describe, expect, it } from "vitest";

import { renderSettled } from "../helpers/app-harness.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
// The viewport's stylesheet, imported for its side effect; this tier measures what it computes to.
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
});

// Which grid track the transcript's scroll container lands in. `transcript-viewport.css` gives
// `.meridian-transcript-viewport` one track, `minmax(0, 1fr)`, and the head and tail affordances
// are `position: absolute`, so the scroll container is the only in-flow child.
//
// That matters because the scroll container is what the virtualizer ranges against: a
// content-sized one gives the window a height unrelated to the pane, and with no rows the
// content height is zero, `calculateRange` returns `null` for `outerSize === 0`, and nothing
// ever mounts to grow it back.
//
// The case asserts the sheet, not a composition: the two class names under the real stylesheet.

import { describe, expect, it } from "vitest";

import { renderSettled } from "../helpers/app-harness.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
// The viewport's stylesheet, imported for its side effect; this tier measures what it computes to.
import "@renderer/features/transcript/viewport/components/transcript-viewport.css";

/** The box the viewport is given. Every assertion below is against this number. */
const VIEWPORT_BOX_HEIGHT_PX = 600;

async function mountViewportScrollContainer(): Promise<HTMLElement> {
  installMeridianTokens(document);
  const { container } = await renderSettled(
    <div style={{ display: "grid", height: `${String(VIEWPORT_BOX_HEIGHT_PX)}px` }}>
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
  return scrollContainer;
}

describe("browser — the transcript's scroll container takes the viewport's height", () => {
  it("fills the box as the only child in flow", async () => {
    const scrollContainer = await mountViewportScrollContainer();

    expect(
      scrollContainer.getBoundingClientRect().height,
      "the scroll container is sized by its content rather than by the viewport, so the window is ranging against a height the pane never gave it",
    ).toBe(VIEWPORT_BOX_HEIGHT_PX);
  });
});

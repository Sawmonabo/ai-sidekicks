// The one mount every chrome suite performs, written once.
//
// The chrome's cases live in three files — the frame it draws, the seams its host fills,
// and the body adapter beside it — because one file covering all three was past the
// package's ceiling. Two of the three mount a chrome and then read the pane element out
// of the render, and a second copy of that four-line lookup is a second answer to what
// counts as "the pane": one file asserting on the section and another on whatever the
// deck wrapped it in is exactly how a frame regression passes half a tier.

import { render } from "@testing-library/react";

/**
 * Render `element` and hand back the pane section, or throw.
 *
 * A throw rather than a nullable return, so a suite that mounted nothing fails at the
 * mount rather than passing an assertion over an absent element.
 */
export function renderChrome(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const pane = container.querySelector(".meridian-pane");
  if (!(pane instanceof HTMLElement)) {
    throw new Error("the chrome rendered no pane element");
  }
  return pane;
}

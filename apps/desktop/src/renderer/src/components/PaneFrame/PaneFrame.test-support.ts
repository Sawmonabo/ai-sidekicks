// The one mount every chrome suite performs, so "the pane" means one element across the suites.

import { render } from "@testing-library/react";

/** Renders `element` and returns the pane section, or throws so an empty mount fails here. */
export function renderPaneFrame(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const pane = container.querySelector(".meridian-pane");
  if (!(pane instanceof HTMLElement)) {
    throw new Error("the chrome rendered no pane element");
  }
  return pane;
}

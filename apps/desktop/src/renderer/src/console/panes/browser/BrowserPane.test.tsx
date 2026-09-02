// The browser pane's shell renders the absence that is true, and not the one that
// would look finished.
//
// The distinction this file exists to hold is rule 8's: `not-checked` says nobody
// asked, `empty` says a read found none. A shell that rendered `empty` would be
// asserting that this session owns no pages — a fact no read established, and one
// an agent's three background pages would contradict without changing a pixel. So
// the assertions are about the kind modifier, and the negative control is the kind
// that would be wrong.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BrowserPane } from "./BrowserPane.js";

function renderBrowserPane(): HTMLElement {
  const { container } = render(<BrowserPane />);
  const region = container.querySelector("section");
  if (!(region instanceof HTMLElement)) {
    throw new Error("BrowserPane rendered no region");
  }
  return region;
}

describe("browser pane shell", () => {
  it("names itself, so the pane is reachable by name", () => {
    expect(renderBrowserPane().getAttribute("aria-label")).toBe("Browser");
  });

  it("renders the not-checked absence, mounted as a surface", () => {
    const absence = renderBrowserPane().querySelector(".meridian-nothing");
    expect(absence?.className).toContain("meridian-nothing--not-checked");
    // A badge here would read as a strip of text in the middle of a pane, which
    // is why placement is named rather than left to the kind's default.
    expect(absence?.className).toContain("meridian-nothing--block");
  });

  it("says what is absent and why, in the console's own words", () => {
    const region = renderBrowserPane();
    expect(region.textContent).toContain("have not been read");
    expect(region.textContent).toContain("Nothing here says there are none");
  });

  it("negative control: it does not render the absence that would look finished", () => {
    // Every case above would pass over a shell that also, or instead, claimed the
    // session has no pages — which is the one thing this surface must not say.
    const absence = renderBrowserPane().querySelector(".meridian-nothing");
    expect(absence?.className).not.toContain("meridian-nothing--empty");
    expect(renderBrowserPane().textContent).not.toContain("No pages");
  });
});

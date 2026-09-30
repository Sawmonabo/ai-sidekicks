// The mono provenance signature is distinguishable from the derived class: collapsing the two
// would keep every screen readable while stripping the signature from every wire figure. The
// exact wire value is exposed in `title` so no formatted figure hides the number the daemon sent.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DerivedFigure } from "../DerivedFigure/DerivedFigure.js";
import { WireFigure } from "./WireFigure.js";

function renderFigure(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const figure = container.firstElementChild;
  if (!(figure instanceof HTMLElement)) {
    throw new Error("Figure rendered no element");
  }
  return figure;
}

describe("the two figure classes are told apart in the output", () => {
  it("marks a wire figure and a derived figure with different classes", () => {
    const wire = renderFigure(<WireFigure value="9f86d081" />);
    const derived = renderFigure(<DerivedFigure text="three rows collapsed" />);

    expect(wire.className).toBe("meridian-figure meridian-figure--wire");
    expect(derived.className).toBe("meridian-figure meridian-figure--derived");
    // Control: one component with a flag would render one class for both.
    expect(wire.className).not.toBe(derived.className);
  });
});

describe("WireFigure — verbatim, and never hiding the value it formats", () => {
  it("renders the value with no transformation", () => {
    const digest = "  b3:9f86d081884c7d659a2feaa0c55ad015  ";
    const figure = renderFigure(<WireFigure value={digest} />);
    expect(figure.textContent).toBe(digest);
    expect(figure.textContent).not.toBe(digest.trim());
  });

  it("carries the exact wire value in `title` when the text is a reading of it", () => {
    // A byte count shown as "1.0 KiB" keeps the exact figure one hover away.
    const figure = renderFigure(<WireFigure value="1.0 KiB" title="1024" />);
    expect(figure.getAttribute("title")).toBe("1024");
    expect(figure.textContent).not.toBe("1024");
  });

  it("emits no `title` attribute when there is no hidden value", () => {
    // A verbatim figure is the wire value, so a title would repeat it; an empty title flashes
    // nothing.
    const figure = renderFigure(<WireFigure value="run.failed" />);
    expect(figure.hasAttribute("title")).toBe(false);
  });
});

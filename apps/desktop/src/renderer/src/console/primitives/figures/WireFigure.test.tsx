// The mono provenance signature, and the fact that it is distinguishable.
//
// The two figure classes are two modules rather than one component with a `mono`
// flag precisely so a call site cannot get the class wrong by omission — which
// means the first property worth testing is not what either renders but that the
// two are DISTINGUISHABLE in the output. A refactor that collapsed them into one
// element with one class would keep every screen readable and would silently strip
// the provenance signature from every wire figure in the console. That case lives
// here rather than beside `DerivedFigure`, because the signature the collapse
// destroys is the WIRE class's; the derived figure is the foil it is told apart
// from.
//
// The rest is the eight rules' closing clause: "the exact wire value is exposed in
// the element's `title` … so no formatted figure hides the number the daemon sent".

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DerivedFigure } from "./DerivedFigure.js";
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
    // The control: a single component with a flag renders one class for both, so
    // requiring the two to differ is what catches that collapse.
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
    // A byte count rendered "1.0 KiB" with the exact figure one hover away — the
    // shape §The eight rules requires of every formatted quantity.
    const figure = renderFigure(<WireFigure value="1.0 KiB" title="1024" />);
    expect(figure.getAttribute("title")).toBe("1024");
    expect(figure.textContent).not.toBe("1024");
  });

  it("emits no `title` attribute when there is no hidden value", () => {
    // A verbatim figure IS the wire value, so a title would repeat it — and an
    // empty-string title is a tooltip that flashes nothing on hover.
    const figure = renderFigure(<WireFigure value="run.failed" />);
    expect(figure.hasAttribute("title")).toBe(false);
  });
});

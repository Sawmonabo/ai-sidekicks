// The derived figure renders the reading and has no prop for a wire value.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DerivedFigure } from "./DerivedFigure.js";

describe("DerivedFigure — the console's own reading, and no wire prop", () => {
  it("renders the reading and offers nowhere to hide a wire value", () => {
    const { container } = render(<DerivedFigure text="waiting on you" />);
    const figure = container.querySelector(".meridian-figure--derived");
    expect(figure?.textContent).toBe("waiting on you");
    expect(figure?.hasAttribute("title")).toBe(false);
  });
});

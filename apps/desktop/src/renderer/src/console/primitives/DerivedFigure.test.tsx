// The console's own reading, and the slot it deliberately does not have.
//
// `WireFigure.test.tsx` owns the claim that the two classes are told apart in the
// output — the signature a collapse would destroy is the wire class's. What is left
// here is the derived figure's own half of rule 4: it renders the reading, and it
// offers nowhere to put "the number this is a reading of", because a `title` on it
// would invite a wire figure to be smuggled through the proportional class.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DerivedFigure } from "./DerivedFigure.js";

describe("DerivedFigure — the console's own reading, and no wire slot", () => {
  it("renders the reading and offers nowhere to hide a wire value", () => {
    const { container } = render(<DerivedFigure text="waiting on you" />);
    const figure = container.querySelector(".meridian-figure--derived");
    expect(figure?.textContent).toBe("waiting on you");
    expect(figure?.hasAttribute("title")).toBe(false);
  });
});

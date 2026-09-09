// What the mark says, and what it deliberately does not offer.
//
// The rule that decides WHEN it renders is `first-launch.test.ts`; these cases are
// about the line itself, because the two fail differently: a rule that is wrong marks
// the wrong window, and a line that is wrong marks the right window with a sentence
// that does not say fixture content is not live.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DemoScenarioMark } from "./DemoScenarioMark.js";

afterEach(() => {
  cleanup();
});

describe("the demonstration mark", () => {
  it("says the rows are scripted and names the composition", () => {
    render(<DemoScenarioMark scenarioLabel="First sixty seconds" />);

    const mark = screen.getByRole("note");

    expect(mark.textContent).toContain("Demonstration");
    expect(mark.textContent).toContain("not a live session");
    expect(mark.textContent).toContain("First sixty seconds");
  });

  it("offers no control at all — it is not dismissible and it is not chrome", () => {
    // A claim about what these rows ARE stops being true the moment it can be put
    // away. Without this case, a later branch adding a dismiss control would leave
    // every assertion above passing while the mark became optional.
    render(<DemoScenarioMark scenarioLabel="First sixty seconds" />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("negative control: it renders the label it is given and not a fixed one", () => {
    // Without this, a mark that hard-coded one composition's name would satisfy the
    // first case and would misname every other scenario it was ever shown for.
    render(<DemoScenarioMark scenarioLabel="Three lanes" />);

    expect(screen.getByRole("note").textContent).toContain("Three lanes");
    expect(screen.getByRole("note").textContent).not.toContain("First sixty seconds");
  });
});

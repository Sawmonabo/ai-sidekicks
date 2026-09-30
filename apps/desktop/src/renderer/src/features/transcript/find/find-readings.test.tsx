// The find walk's reading, and the sentence the shared primitive says for it. Both halves are
// driven: a model test alone passes while the transcript keeps its own notices, and a render
// alone passes over a model that reports a cut walk as whole.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PartialRead } from "@renderer/components/PartialRead/PartialRead.js";
import { matchWalkReading } from "./find-readings.js";

function renderWalk(
  servedMatchCount: number,
  unreachedMatchCount: number,
  subject: string,
): HTMLElement {
  const { container } = render(
    <PartialRead
      states={[matchWalkReading(servedMatchCount, unreachedMatchCount)]}
      subject={subject}
    />,
  );
  return container;
}

describe("the find walk's reading", () => {
  it("is served when every match is inside the walk", () => {
    expect(matchWalkReading(12, 0)).toStrictEqual({ kind: "served" });
  });

  it("is cut when matches lie outside it, and leads with what was read", () => {
    expect(matchWalkReading(12, 3)).toStrictEqual({ kind: "cut", servedCount: 12 });
  });

  it("counts a walk that reached nothing as cut too", () => {
    // The arm is decided by what is hidden, so a query with every match outside the window
    // still says so, with a figure of zero.
    expect(matchWalkReading(0, 4)).toStrictEqual({ kind: "cut", servedCount: 0 });
  });
});

describe("the find walk's reading, on screen", () => {
  it("says the cap cut this window, in the console's shared sentence", () => {
    renderWalk(12, 3, "this window");
    expect(
      screen.getByText(
        /read before the answer for this window was cut short, so what is not shown here may still exist/u,
      ),
    ).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("says a fold cut the walk, under its own subject", () => {
    renderWalk(2, 5, "the run groups this transcript has folded");
    expect(
      screen.getByText(
        /read before the answer for the run groups this transcript has folded was cut short, so what is not shown here may still exist/u,
      ),
    ).toBeTruthy();
  });

  it("negative control: a walk that reached every match renders nothing at all", () => {
    // Fails on a `cut` state minted unconditionally.
    const container = renderWalk(12, 0, "this window");
    expect(container.querySelector(".meridian-partial-read")).toBeNull();
    expect(container.textContent).toBe("");
  });
});

// The find walk's reading, and the sentence the shared primitive says for it.
//
// Both halves, because either alone passes over the defect this rebind answers: a
// model asserting `{kind: "cut"}` would pass while the ledger kept its own two
// notices beside it, and a render asserting a sentence would pass over a model that
// reported a cut walk as whole. So the cases below drive `matchWalkReading` into
// `PartialRead` and read what reaches the screen.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PartialRead } from "../../../primitives/index.js";
import { matchWalkReading } from "./ledger-find-readings.js";

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
    // The arm is decided by what is HIDDEN, so a query whose every match is outside
    // the window still says so — with a figure of zero, which is true of the walk.
    expect(matchWalkReading(0, 4)).toStrictEqual({ kind: "cut", servedCount: 0 });
  });
});

describe("the find walk's reading, on screen", () => {
  it("says the cap cut this window, in the console's shared sentence", () => {
    renderWalk(12, 3, "this window");
    expect(
      screen.getByText(
        /read before this window was cut, so what is not shown here may still exist/u,
      ),
    ).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("says the replay cut the walk, under its own subject", () => {
    renderWalk(2, 5, "this replay's walk");
    expect(
      screen.getByText(
        /read before this replay's walk was cut, so what is not shown here may still exist/u,
      ),
    ).toBeTruthy();
  });

  it("negative control: a walk that reached every match renders nothing at all", () => {
    // The case the deleted notices guarded with a `count === 0` early return. The
    // guard is the model's now, so this fails on a `cut` state minted unconditionally.
    const container = renderWalk(12, 0, "this window");
    expect(container.querySelector(".meridian-partial-read")).toBeNull();
    expect(container.textContent).toBe("");
  });
});

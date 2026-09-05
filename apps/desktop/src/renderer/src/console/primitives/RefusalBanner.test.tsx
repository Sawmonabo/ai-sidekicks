// The banner's own half of the grammar: whether a person can put it away.
//
// `refusal-contract.test.tsx` owns everything the three shapes do the same way —
// the spread, the mono asymmetry, the verbatim message, the action slot, and the
// live-region posture — and drives all three through the props they share. What is
// left here is the one member no other shape has, so the refusal below is the one a
// banner is actually for: what the whole room can do has changed.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { refuse } from "../core/index.js";
import { RefusalBanner } from "./RefusalBanner.js";

/** Room-wide, which is the blast radius the banner shape exists for. */
const ROOM_WIDE_REFUSAL = refuse(
  "runtime-node",
  "runtimenode.permission_denied",
  "That runtime node is no longer attached, so no run can start here.",
);

describe("a banner is dismissable only when the caller can dismiss it", () => {
  it("renders a labelled dismiss control that calls back", () => {
    const onDismiss = vi.fn();
    const { container } = render(<RefusalBanner {...ROOM_WIDE_REFUSAL} onDismiss={onDismiss} />);
    const dismiss = container.querySelector(".meridian-refusal__dismiss");

    expect(dismiss?.getAttribute("aria-label")).toBe("Dismiss this notice");
    if (!(dismiss instanceof HTMLButtonElement)) {
      throw new Error("the dismissable banner rendered no dismiss button");
    }
    dismiss.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders no dismiss control when the banner clears with its condition", () => {
    const { container } = render(<RefusalBanner {...ROOM_WIDE_REFUSAL} />);
    expect(container.querySelector(".meridian-refusal__dismiss")).toBeNull();
  });
});
